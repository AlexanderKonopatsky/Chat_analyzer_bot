require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const unrar = require('node-unrar-js');
const axios = require('axios');
const { processSingleFile } = require('./single-file-converter');

// Загрузка конфигурации из .env файла
const token = process.env.TELEGRAM_BOT_TOKEN || '7982004413:AAHW-NHd2ax_7b7i53nE5nyBu-JYMGqsdm0';
const openrouterApiKey = process.env.OPENROUTER_API_KEY;

// Настройки повторных попыток
const MAX_RETRIES = 5;
const RETRY_DELAY = 3000;

// Создание нового экземпляра бота с опциями
const bot = new TelegramBot(token, { 
  polling: {
    interval: 300,
    params: {
      timeout: 10
    },
    autoStart: true,
    // Обработка ошибок при polling
    error: (error) => {
      console.error('Ошибка при polling:', error.message);
    }
  },
  request: {
    // Увеличенные таймауты
    timeout: 30000,
    // Повторные попытки при ошибках соединения
    retries: MAX_RETRIES,
    retryDelay: RETRY_DELAY
  }
});

// Обработка неперехваченных отклонений обещаний
process.on('unhandledRejection', (reason, promise) => {
  console.error('Неперехваченное отклонение promise:', reason);
});

// Папки для хранения временных файлов
const uploadsDir = path.join(__dirname, 'telegram_uploads');
const extractDir = path.join(__dirname, 'telegram_extracted');
const outputDir = path.join(__dirname, 'telegram_results');
const promptsDir = path.join(__dirname, 'telegram_prompts');
const analysisDir = path.join(__dirname, 'telegram_analysis');

// Создаем папки, если они не существуют
[uploadsDir, extractDir, outputDir, promptsDir, analysisDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Хранилище состояний пользователей
const userStates = {};

// Доступные модели LLM (в порядке убывания цены)
const availableModels = [
  { 
    id: 'anthropic/claude-3.7-sonnet', 
    name: 'Claude 3.7 Sonnet', 
    price: '$3/M токенов',
    input_price: 3.00,
    output_price: 15.00
  },
  { 
    id: 'openai/gpt-4.1', 
    name: 'GPT-4.1', 
    price: '$2/M токенов',
    input_price: 2.00,
    output_price: 8.00
  },
  { 
    id: 'google/gemini-2.5-pro-preview', 
    name: 'Gemini 2.5 Pro Preview', 
    price: '$1.25/M токенов',
    input_price: 1.25,
    output_price: 10
  },
  { 
    id: 'openai/gpt-4.1-mini', 
    name: 'GPT-4.1 Mini', 
    price: '$0.40/M токенов',
    input_price: 0.40,
    output_price: 1.60
  },
  { 
    id: 'meta-llama/llama-4-maverick', 
    name: 'Llama 4 Maverick', 
    price: '$0.17/M токенов',
    input_price: 0.17,
    output_price: 0.6
  },
  { 
    id: 'google/gemini-2.5-flash-preview', 
    name: 'Gemini 2.5 Flash Preview', 
    price: '$0.15/M токенов',
    input_price: 0.15,
    output_price: 0.6
  },
  { 
    id: 'openai/gpt-4.1-nano', 
    name: 'GPT-4.1 Nano', 
    price: '$0.10/M токенов',
    input_price: 0.1,
    output_price: 0.4
  },
  { 
    id: 'google/gemini-2.0-flash-001', 
    name: 'Gemini 2.0 Flash', 
    price: '$0.10/M токенов',
    input_price: 0.1,
    output_price: 0.4
  },
  { 
    id: 'qwen/qwen-turbo', 
    name: 'Qwen Turbo', 
    price: '$0.05/M токенов',
    input_price: 0.05,
    output_price: 0.2
  },
  { 
    id: 'google/gemini-flash-1.5-8b', 
    name: 'Gemini Flash 1.5', 
    price: '$0.038/M токенов',
    input_price: 0.038,
    output_price: 0.15
  }
];

// Функция для генерации главного меню
function getMainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: '📝 Выбрать промпт для анализа' }],
        [{ text: '📊 Анализ' }], 
        [{ text: '📤 Загрузить ZIP или RAR архив' }],
        [{ text: '❓ Помощь' }, { text: '🔄 Очистить' }]
      ],
      resize_keyboard: true
    }
  };
}

// Функция для получения меню выбора модели
function getModelSelectionMenu(prefix = 'model:') {
  const inlineKeyboard = availableModels.map(model => {
    // Ограничиваем длину отображаемого текста в кнопке
    const modelName = model.name.length > 15 ? model.name.substring(0, 15) + '...' : model.name;
    return [{ text: `${modelName} (${model.price})`, callback_data: `${prefix}${model.id}` }];
  });
  
  return {
    reply_markup: {
      inline_keyboard: inlineKeyboard
    }
  };
}

// Функция для получения меню управления промптами
function getPromptsMenu(chatId) {
  const userPromptsFile = path.join(promptsDir, `${chatId}.json`);
  let prompts = [];
  
  if (fs.existsSync(userPromptsFile)) {
    try {
      prompts = JSON.parse(fs.readFileSync(userPromptsFile, 'utf8'));
    } catch (err) {
      console.error('Ошибка при чтении файла промптов:', err);
    }
  }
  
  const inlineKeyboard = [];
  
  // Добавляем существующие промпты с возможностью удаления
  prompts.forEach((prompt, index) => {
    // Ограничиваем длину имени промпта для безопасного отображения
    const promptName = prompt.name.length > 20 ? prompt.name.substring(0, 20) + '...' : prompt.name;
    inlineKeyboard.push([
      { text: promptName, callback_data: `prompt_select:${index}` },
      { text: '❌', callback_data: `prompt_delete:${index}` }
    ]);
  });
  
  // Добавляем кнопку для создания нового промпта
  inlineKeyboard.push([{ text: '➕ Добавить новый промпт', callback_data: 'prompt_add' }]);
  
  return {
    reply_markup: {
      inline_keyboard: inlineKeyboard
    }
  };
}

// Инициализация состояния пользователя
function initUserState(chatId) {
  if (!userStates[chatId]) {
    userStates[chatId] = {
      currentState: 'main', // 'main', 'prompt_adding', 'waiting_for_file', 'processing', 'waiting_for_txt', и т.д.
      selectedModel: availableModels[0].id, // По умолчанию первая модель
      selectedPrompt: null,
      promptName: null,
      promptText: '', // Для хранения текста промпта при многострочном вводе
      uploadedTextFiles: [], // Массив для хранения загруженных текстовых файлов
      combinedTextPath: null, // Путь к объединенному текстовому файлу
      analysisPrompt: null, // Промпт для текущего анализа
      analysisModel: null, // Модель для текущего анализа
      analyzeInParts: false // Флаг для режима анализа (целиком или по частям)
    };
  }
  return userStates[chatId];
}

// Сохранение промптов пользователя
function saveUserPrompts(chatId, prompts) {
  const userPromptsFile = path.join(promptsDir, `${chatId}.json`);
  try {
    fs.writeFileSync(userPromptsFile, JSON.stringify(prompts, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Ошибка при сохранении промптов:', err);
    return false;
  }
}

// Получение промптов пользователя
function getUserPrompts(chatId) {
  const userPromptsFile = path.join(promptsDir, `${chatId}.json`);
  if (fs.existsSync(userPromptsFile)) {
    try {
      return JSON.parse(fs.readFileSync(userPromptsFile, 'utf8'));
    } catch (err) {
      console.error('Ошибка при чтении файла промптов:', err);
      return [];
    }
  }
  return [];
}

// Обработка команды /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  initUserState(chatId);
  
  const welcomeMessage = 'Добро пожаловать! Этот бот поможет вам конвертировать и анализировать переписку.\n\n' +
    'Используйте кнопки меню для навигации:';
  
  sendMessageWithRetry(chatId, welcomeMessage, getMainMenu());
});

// Обработка команды /help
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = 'Инструкция по использованию бота:\n\n' +
    '1. Выберите модель LLM для анализа (опционально).\n' +
    '2. Создайте промпт или выберите существующий (опционально).\n' +
    '3. Отправьте архив (.zip или .rar) с HTML-файлами для конвертации.\n' +
    '4. Получите результат в виде текстового файла.\n' +
    '5. При необходимости запустите анализ текста, выбрав режим анализа (целиком или по частям).\n\n' +
    'Поддерживаемые форматы: .zip и .rar архивы с HTML-файлами.';
  
  sendMessageWithRetry(chatId, helpMessage, getMainMenu());
});

// Обработка текстовых сообщений для навигации по меню
bot.on('message', async (msg) => {
  if (!msg.text || msg.document) return; // Пропускаем обработку сообщений без текста или с документами
  
  const chatId = msg.chat.id;
  const text = msg.text;
  const userState = initUserState(chatId);
  
  // Обработка состояния ввода промпта
  if (userState.currentState === 'prompt_adding_text') {
    // Проверяем, является ли сообщение командой завершения ввода промпта
    if (text === '/done' || text === '✅ Готово') {
      const prompts = getUserPrompts(chatId);
      prompts.push({
        name: userState.promptName || `Промпт #${prompts.length + 1}`,
        text: userState.promptText,
        created: new Date().toISOString()
      });
      
      if (saveUserPrompts(chatId, prompts)) {
        await sendMessageWithRetry(chatId, `✅ Промпт "${userState.promptName || `Промпт #${prompts.length}`}" успешно сохранен!`);
        userState.currentState = 'main';
        userState.promptText = ''; // Очищаем буфер текста промпта
        await sendMessageWithRetry(chatId, 'Что вы хотите сделать дальше?', getMainMenu());
      } else {
        await sendMessageWithRetry(chatId, '❌ Ошибка при сохранении промпта. Попробуйте еще раз.', getMainMenu());
        userState.currentState = 'main';
        userState.promptText = ''; // Очищаем буфер текста промпта
      }
      return;
    }
    
    // Добавляем текст к существующему промпту
    if (userState.promptText) {
      userState.promptText += '\n' + text; // Добавляем новую строку и текущее сообщение
    } else {
      userState.promptText = text; // Это первое сообщение
    }
    
    // Отправляем статус ввода
    await sendMessageWithRetry(chatId, 'Текст добавлен. Продолжайте ввод или отправьте /done или нажмите кнопку "✅ Готово", чтобы завершить.', {
      reply_markup: {
        keyboard: [
          [{ text: '✅ Готово' }],
          [{ text: '❌ Отмена' }]
        ],
        resize_keyboard: true
      }
    });
    return;
  }
  
  // Обработка состояния ввода имени промпта
  if (userState.currentState === 'prompt_adding_name') {
    userState.promptName = text;
    userState.promptText = ''; // Инициализируем пустым текстом
    userState.currentState = 'prompt_adding_text';
    await sendMessageWithRetry(chatId, `Теперь введите текст промпта для "${text}".\nВы можете отправить несколько сообщений. Когда закончите, отправьте /done или нажмите кнопку "✅ Готово".`, {
      reply_markup: {
        keyboard: [
          [{ text: '✅ Готово' }],
          [{ text: '❌ Отмена' }]
        ],
        resize_keyboard: true
      }
    });
    return;
  }
  
  // Обработка состояния ввода промпта для анализа
  if (userState.currentState === 'analysis_prompt_input') {
    userState.analysisPrompt = {
      name: 'Временный промпт',
      text: text,
      created: new Date().toISOString()
    };
    
    userState.currentState = 'analysis_model_selection';
    await sendMessageWithRetry(chatId, 'Выберите модель для анализа:', getModelSelectionMenu('analysis_model:'));
    return;
  }
  
  // Обработка основных команд меню
  switch (text) {
    case '📤 Загрузить ZIP или RAR архив':
      userState.currentState = 'waiting_for_file';
      await sendMessageWithRetry(chatId, 'Отправьте ZIP или RAR архив с HTML-файлами для обработки.');
      break;
      
    case '📝 Выбрать промпт для анализа': 
      await sendMessageWithRetry(chatId, 'Ваши сохраненные промпты:', getPromptsMenu(chatId));
      break;
      
    case '📊 Анализ':
      userState.currentState = 'waiting_for_txt';
      userState.uploadedTextFiles = []; // Сбросим список файлов перед новым анализом
      
      await sendMessageWithRetry(chatId, 'Отправьте текстовые файлы (.txt) с диалогами для анализа. ' + 
        'Вы можете отправить несколько файлов.\n\n' +
        'После загрузки всех файлов нажмите кнопку "Завершить загрузку".',
        {
          reply_markup: {
            keyboard: [
              [{ text: '✅ Завершить загрузку' }],
              [{ text: '❌ Отмена' }]
            ],
            resize_keyboard: true
          }
        });
      break;
      
    case '❓ Помощь':
      const helpMessage = 'Инструкция по использованию бота:\n\n' +
        '1. Сначала создайте текстовый файл из архива с помощью кнопки "📤 Загрузить ZIP или RAR архив"\n' +
        '2. При желании задайте постоянный промпт через "📝 Выбрать промпт для анализа"\n' +
        '3. Нажмите "📊 Анализ", загрузите TXT файл(ы) и нажмите "Завершить загрузку"\n' +
        '4. Выберите промпт и модель для анализа\n' +
        '5. Выберите способ анализа (целиком или по частям)\n' +
        '6. Дождитесь результата анализа\n\n' +
        'При выборе режима "Разбить на части", файл будет обработан поэтапно. После завершения вам будет предложено создать дополнительный общий анализ на основе всех полученных частей.';
      
      await sendMessageWithRetry(chatId, helpMessage, getMainMenu());
      break;
    
    case '🔄 Очистить':
      // Полная очистка состояния - сбрасываем все параметры
      userState.currentState = 'main';
      userState.uploadedTextFiles = [];
      userState.promptText = '';
      userState.selectedPrompt = null;
      userState.analysisPrompt = null;
      userState.analysisModel = null;
      userState.combinedTextPath = null;
      userState.analysisResults = null;
      userState.analysisChunkSize = null;
      userState.lastAnalysisModel = null;
      
      // Создаем новый statusMessage для избежания конфликтов
      await sendMessageWithRetry(chatId, 'Все текущие операции отменены. Память бота очищена.', getMainMenu());
      break;
      
    case '🤖 Выбрать модель':
      await sendMessageWithRetry(chatId, 'Выберите модель LLM для анализа:', getModelSelectionMenu());
      break;
      
    case '💬 Управление промптами':
      await sendMessageWithRetry(chatId, 'Ваши сохраненные промпты:', getPromptsMenu(chatId));
      break;
      
    case '✅ Завершить загрузку':
      if (userState.currentState === 'waiting_for_txt') {
        if (userState.uploadedTextFiles.length === 0) {
          await sendMessageWithRetry(chatId, 'Вы не загрузили ни одного текстового файла. Пожалуйста, загрузите хотя бы один файл или отмените операцию.');
          return;
        }
        
        await sendMessageWithRetry(chatId, `Вы загрузили ${userState.uploadedTextFiles.length} файл(ов). Объединяю их для анализа...`);
        
        // Объединяем все загруженные файлы
        const combinedTextPath = await combineTextFiles(chatId, userState.uploadedTextFiles);
        
        if (!combinedTextPath) {
          await sendMessageWithRetry(chatId, 'Произошла ошибка при объединении файлов. Попробуйте еще раз.');
          userState.currentState = 'main';
          await sendMessageWithRetry(chatId, 'Что вы хотите сделать дальше?', getMainMenu());
          return;
        }
        
        userState.combinedTextPath = combinedTextPath;
        
        // Предлагаем выбрать промпт для анализа или создать новый
        await sendMessageWithRetry(chatId, 'Выберите промпт для анализа или создайте новый:', 
          getPromptsMenuForAnalysis(chatId));
        
        userState.currentState = 'analysis_prompt_selection';
      } else {
        await sendMessageWithRetry(chatId, 'Эта команда доступна только при загрузке файлов для анализа.', getMainMenu());
      }
      break;
      
    case '❌ Отмена':
      if (userState.currentState === 'waiting_for_txt' || 
          userState.currentState === 'analysis_prompt_selection' ||
          userState.currentState === 'analysis_prompt_input' ||
          userState.currentState === 'analysis_model_selection' ||
          userState.currentState === 'prompt_adding_text' ||
          userState.currentState === 'prompt_adding_name') {
        userState.currentState = 'main';
        userState.uploadedTextFiles = [];
        userState.promptText = ''; // Очищаем текст промпта при отмене
        await sendMessageWithRetry(chatId, 'Операция отменена.', getMainMenu());
      } else {
        await sendMessageWithRetry(chatId, 'Возвращаемся в главное меню.', getMainMenu());
      }
      break;
  }
});

// Хранилище для отслеживания обработанных callback-запросов
const processedCallbacks = new Map();

// Обработка callback-запросов для инлайн-кнопок
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const messageId = callbackQuery.message.message_id;
  const callbackId = callbackQuery.id;
  const userState = initUserState(chatId);
  
  // Защита от повторной обработки одного и того же callback
  const callbackKey = `${chatId}_${messageId}_${data}`;
  const now = Date.now();
  
  if (processedCallbacks.has(callbackKey)) {
    const lastProcessedTime = processedCallbacks.get(callbackKey);
    // Если callback обработан менее 5 секунд назад, пропускаем повторную обработку
    if (now - lastProcessedTime < 5000) {
      console.log(`Пропуск повторного callback: ${callbackKey}`);
      await bot.answerCallbackQuery(callbackId, { text: 'Пожалуйста, не нажимайте кнопки слишком часто' });
      return;
    }
  }
  
  // Записываем время обработки текущего callback
  processedCallbacks.set(callbackKey, now);
  
  // Очистка старых записей из Map каждые 10 минут
  setTimeout(() => processedCallbacks.delete(callbackKey), 600000);
  
  // Обработка выбора модели
  if (data.startsWith('model:')) {
    const modelId = data.split(':')[1];
    userState.selectedModel = modelId;
    
    const selectedModel = availableModels.find(m => m.id === modelId);
    await bot.answerCallbackQuery(callbackQuery.id, { text: `Выбрана модель: ${selectedModel.name}` });
    await bot.editMessageText(`Вы выбрали модель: ${selectedModel.name} (${selectedModel.price})`, {
      chat_id: chatId,
      message_id: messageId
    });
    
    setTimeout(async () => {
      await sendMessageWithRetry(chatId, 'Что вы хотите сделать дальше?', getMainMenu());
    }, 500);
    return;
  }
  
  // Обработка выбора модели для анализа
  if (data.startsWith('analysis_model:')) {
    const modelId = data.split(':')[1];
    userState.analysisModel = modelId;
    
    const selectedModel = availableModels.find(m => m.id === modelId);
    await bot.answerCallbackQuery(callbackQuery.id, { text: `Выбрана модель: ${selectedModel.name}` });
    
    // Получаем размер файла для информации
    const fileStats = fs.statSync(userState.combinedTextPath);
    const fileSizeKB = Math.round(fileStats.size / 1024);
    
    // Показываем варианты анализа вместо сразу сводки
    let analysisOptionsText = '📋 *Выберите способ анализа:*\n\n';
    analysisOptionsText += `📄 Файл размером: ${fileSizeKB} КБ\n`;
    analysisOptionsText += `💬 Промпт: ${userState.analysisPrompt?.name || 'Временный промпт'}\n`;
    analysisOptionsText += `🤖 Модель: ${selectedModel.name} (${selectedModel.price})\n\n`;
    analysisOptionsText += 'Выберите, как вы хотите анализировать этот текст:';
    
    try {
      await bot.editMessageText(analysisOptionsText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Анализировать целиком', callback_data: 'analyze_whole' }],
            [{ text: '✂️ Разбить на части', callback_data: 'analyze_parts' }]
          ]
        }
      });
      
      userState.currentState = 'analysis_method_selection';
    } catch (error) {
      console.error('Ошибка при отображении опций анализа:', error);
      
      // Упрощенная версия при ошибке
      let simpleOptionsText = '📋 *Выберите способ анализа:*\n\n';
      simpleOptionsText += `Выберите, как анализировать текст (${fileSizeKB} КБ):`;
      
      await bot.editMessageText(simpleOptionsText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Анализировать целиком', callback_data: 'analyze_whole' }],
            [{ text: '✂️ Разбить на части', callback_data: 'analyze_parts' }]
          ]
        }
      });
      
      userState.currentState = 'analysis_method_selection';
    }
    
    return;
  }
  
  // Обработка выбора метода анализа (целиком или по частям)
  if (data === 'analyze_whole' || data === 'analyze_parts') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Подготовка к анализу...' });
    
    // Устанавливаем флаг в состоянии пользователя
    userState.analyzeInParts = (data === 'analyze_parts');
    
    // Показываем сводку выбранных параметров и подтверждаем
    let summaryText = '📋 *Сводка перед анализом:*\n\n';
    summaryText += `📄 Файлов объединено: ${userState.uploadedTextFiles.length}\n`;
    
    // Предотвращаем ошибку слишком длинного сообщения с промптом
    const promptName = userState.analysisPrompt.name;
    summaryText += `💬 Промпт: ${promptName}\n`;
    
    const selectedModel = availableModels.find(m => m.id === userState.analysisModel);
    summaryText += `🤖 Модель: ${selectedModel.name} (${selectedModel.price})\n`;
    summaryText += `📊 Метод анализа: ${userState.analyzeInParts ? 'Разбиение на части' : 'Целиком'}\n\n`;
    summaryText += 'Нажмите кнопку ниже, чтобы запустить анализ текста.';
    
    try {
      await bot.editMessageText(summaryText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Анализировать', callback_data: 'start_analysis' }]
          ]
        }
      });
      
      userState.currentState = 'analysis_confirmation';
    } catch (error) {
      console.error('Ошибка при отображении сводки перед анализом:', error);
      
      // Упрощенная версия без деталей промпта
      let simpleSummaryText = '📋 *Анализ готов к запуску*\n\n';
      simpleSummaryText += `📊 Метод: ${userState.analyzeInParts ? 'Разбиение на части' : 'Целиком'}\n\n`;
      simpleSummaryText += 'Нажмите кнопку ниже, чтобы начать.';
      
      await bot.editMessageText(simpleSummaryText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Анализировать', callback_data: 'start_analysis' }]
          ]
        }
      });
      
      userState.currentState = 'analysis_confirmation';
    }
    
    return;
  }
  
  // Обработка добавления промпта
  if (data === 'prompt_add') {
    // Сразу переходим к вводу текста промпта без запроса названия
    userState.currentState = 'prompt_adding_text';
    userState.promptName = null; // Будет сгенерировано автоматически
    userState.promptText = ''; // Инициализируем пустой текст
    await bot.answerCallbackQuery(callbackQuery.id);
    await sendMessageWithRetry(chatId, 'Введите текст промпта. Вы можете отправить несколько сообщений. Когда закончите, отправьте /done или нажмите кнопку "✅ Готово".', {
      reply_markup: {
        keyboard: [
          [{ text: '✅ Готово' }],
          [{ text: '❌ Отмена' }]
        ],
        resize_keyboard: true
      }
    });
    return;
  }
  
  // Добавление нового промпта специально для анализа
  if (data === 'analysis_prompt_add') {
    userState.currentState = 'analysis_prompt_input';
    await bot.answerCallbackQuery(callbackQuery.id);
    await sendMessageWithRetry(chatId, 'Введите текст промпта для анализа:');
    return;
  }
  
  // Обработка выбора промпта для анализа
  if (data.startsWith('analysis_prompt_select:')) {
    const promptIndex = parseInt(data.split(':')[1]);
    const prompts = getUserPrompts(chatId);
    
    if (promptIndex >= 0 && promptIndex < prompts.length) {
      userState.analysisPrompt = prompts[promptIndex];
      await bot.answerCallbackQuery(callbackQuery.id, { text: `Выбран промпт: ${prompts[promptIndex].name}` });
      
      // Переходим к выбору модели
      userState.currentState = 'analysis_model_selection';
      
      try {
        // Проверяем длину промпта для безопасного отображения
        const safePromptText = getSafePromptText(prompts[promptIndex].text);
        const message = `Вы выбрали промпт для анализа: ${prompts[promptIndex].name}\n\n${safePromptText ? 'Предпросмотр промпта:\n' + safePromptText + '\n\n' : ''}Теперь выберите модель:`;
        
        await bot.editMessageText(message, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: getModelSelectionMenu('analysis_model:').reply_markup
        });
      } catch (error) {
        console.error('Ошибка при отображении промпта:', error);
        
        // В случае ошибки отправляем сокращенное сообщение
        await bot.editMessageText(`Вы выбрали промпт для анализа: ${prompts[promptIndex].name}\n\nТеперь выберите модель:`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: getModelSelectionMenu('analysis_model:').reply_markup
        });
      }
    }
    return;
  }
  
  // Обработка выбора промпта
  if (data.startsWith('prompt_select:')) {
    const promptIndex = parseInt(data.split(':')[1]);
    const prompts = getUserPrompts(chatId);
    
    if (promptIndex >= 0 && promptIndex < prompts.length) {
      userState.selectedPrompt = promptIndex;
      await bot.answerCallbackQuery(callbackQuery.id, { text: `Выбран промпт: ${prompts[promptIndex].name}` });
      
      try {
        // Пытаемся отправить промпт (как сообщение или как файл)
        await sendPromptToUser(chatId, prompts[promptIndex].name, prompts[promptIndex].text, messageId);
      } catch (error) {
        console.error('Ошибка при отображении промпта:', error);
        
        // В случае ошибки уведомляем пользователя и отправляем промпт как файл
        await bot.editMessageText(`Промпт слишком длинный для отображения. Отправляю как файл...`, {
          chat_id: chatId,
          message_id: messageId
        });
        
        // Создаем временный файл с содержимым промпта
        const tempFilePath = path.join(promptsDir, `temp_prompt_${Date.now()}.txt`);
        fs.writeFileSync(tempFilePath, `Промпт: ${prompts[promptIndex].name}\n\n${prompts[promptIndex].text}`, 'utf8');
        
        // Отправляем файл
        await bot.sendDocument(chatId, fs.createReadStream(tempFilePath), {
          caption: `Промпт: ${prompts[promptIndex].name}`
        });
        
        // Удаляем временный файл после отправки
        setTimeout(() => {
          try {
            if (fs.existsSync(tempFilePath)) {
              fs.unlinkSync(tempFilePath);
            }
          } catch (err) {
            console.error('Ошибка при удалении временного файла промпта:', err);
          }
        }, 5000);
      }
      
      setTimeout(async () => {
        await sendMessageWithRetry(chatId, 'Что вы хотите сделать дальше?', getMainMenu());
      }, 500);
    }
    return;
  }
  
  // Обработка удаления промпта
  if (data.startsWith('prompt_delete:')) {
    const promptIndex = parseInt(data.split(':')[1]);
    const prompts = getUserPrompts(chatId);
    
    if (promptIndex >= 0 && promptIndex < prompts.length) {
      const promptName = prompts[promptIndex].name;
      prompts.splice(promptIndex, 1);
      
      if (saveUserPrompts(chatId, prompts)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: `Промпт удален: ${promptName}` });
        await bot.editMessageText('Ваши сохраненные промпты:', {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: getPromptsMenu(chatId).reply_markup
        });
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Ошибка при удалении промпта' });
      }
    }
    return;
  }
  
  // Обработка запуска анализа
  if (data === 'start_analysis') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Запуск анализа...' });
    
    // Обновляем сообщение о начале анализа
    await bot.editMessageText('⏳ Отправляем запрос в модель. Это может занять некоторое время...\n\nОбрабатываем текст большого объема - ожидайте ответа.', {
      chat_id: chatId,
      message_id: messageId
    });
    
    // Запускаем анализ с помощью OpenRouter API
    try {
      if (!openrouterApiKey) {
        throw new Error('API ключ OpenRouter не найден. Проверьте файл .env');
      }
      
      if (!userState.combinedTextPath || !fs.existsSync(userState.combinedTextPath)) {
        throw new Error('Объединенный текстовый файл не найден');
      }
      
      // Читаем содержимое объединенного файла
      const textContent = fs.readFileSync(userState.combinedTextPath, 'utf8');
      
      // Формируем промпт для модели
      const prompt = userState.analysisPrompt.text;
      
      // Получаем размер файла
      const fileSize = textContent.length;
      const fileSizeKB = Math.round(fileSize / 1024);
      
      // Проверяем, выбрал ли пользователь режим разбиения на части
      const shouldSplitIntoChunks = userState.analyzeInParts === true;
      
      // Если пользователь выбрал разбиение на части или размер очень большой
      // Размер очень большой для безопасного лимита API - принудительно используем части
      const MAX_SAFE_SIZE = 100500000; // Увеличено с 800 КБ до 1.5 МБ
      
      if (shouldSplitIntoChunks || fileSize > MAX_SAFE_SIZE) {
        // Если пользователь не выбрал разбиение, но размер очень большой - предупреждаем
        if (!shouldSplitIntoChunks && fileSize > MAX_SAFE_SIZE) {
          // Обновляем сообщение с предупреждением
          await bot.editMessageText(`📊 Файл слишком большой (${fileSizeKB} КБ) для обработки за один раз.\n\nНесмотря на выбранный режим анализа целиком, будет применен многочастный анализ из-за большого размера текста.\nРезультаты будут отправлены по мере обработки...`, {
            chat_id: chatId,
            message_id: messageId
          });
        } else {
          // Обновляем сообщение о начале мультичастного анализа
          await bot.editMessageText(`📊 Начинаем многочастный анализ текста (${fileSizeKB} КБ).\n\nРезультаты будут отправлены по мере обработки каждой части...`, {
            chat_id: chatId,
            message_id: messageId
          });
        }
        
        // Запускаем анализ по частям
        await analyzeTextInChunks(chatId, messageId, userState.analysisModel, prompt, textContent);
        
        // Сразу возвращаем управление пользователю
        userState.currentState = 'main';
        return;
      }
      
      // Для файлов в пределах безопасного размера или если пользователь выбрал "целиком"
      // Анализируем весь текст
      await bot.editMessageText(`⏳ Отправляем запрос в модель...\n\nРазмер анализируемых данных: ${fileSizeKB} КБ\nЭто может занять некоторое время.`, {
        chat_id: chatId,
        message_id: messageId
      });
      
      const fullPrompt = `${prompt}\n\nВот текст для анализа:\n${textContent}`;
      
      // Отправляем запрос к OpenRouter API
      const result = await analyzeTextWithLLM(userState.analysisModel, fullPrompt);
      
      // Сохраняем результат в HTML файл
      const htmlResult = createHtmlResult(result, {
        model: userState.analysisModel,
        prompt: userState.analysisPrompt.text,
        fileName: path.basename(userState.combinedTextPath)
      });
      
      // Путь для сохранения результата
      const userAnalysisDir = path.join(analysisDir, chatId.toString());
      if (!fs.existsSync(userAnalysisDir)) {
        fs.mkdirSync(userAnalysisDir, { recursive: true });
      }
      const resultPath = path.join(userAnalysisDir, `analysis_result_${Date.now()}.html`);
      
      // Сохраняем HTML файл
      fs.writeFileSync(resultPath, htmlResult, 'utf8');
      
      // Отправляем результат пользователю
      try {
        await bot.sendDocument(chatId, fs.createReadStream(resultPath), {
          caption: `Результат анализа (модель: ${availableModels.find(m => m.id === userState.analysisModel).name})`
        });
        
        // Обновляем сообщение
        await bot.editMessageText('✅ Анализ успешно завершен!', {
          chat_id: chatId,
          message_id: messageId
        });
      } catch (error) {
        console.error('Ошибка при отправке результата анализа:', error);
        
        // Если произошла ошибка при отправке, попробуем отправить повторно без дополнительной информации
        await bot.sendDocument(chatId, fs.createReadStream(resultPath), {
          caption: `Результат анализа`
        });
        
        await bot.editMessageText('✅ Анализ завершен (возникли небольшие проблемы при отправке результата).', {
          chat_id: chatId,
          message_id: messageId
        });
      }
      
      userState.currentState = 'main';
      setTimeout(async () => {
        await sendMessageWithRetry(chatId, 'Что вы хотите сделать дальше?', getMainMenu());
      }, 500);
    } catch (error) {
      console.error('Ошибка при анализе текста:', error);
      
      // Формируем более информативное сообщение об ошибке
      let errorMessage = `❌ Произошла ошибка при анализе: ${error.message}`;
      
      // Добавляем рекомендации в зависимости от типа ошибки
      if (error.message.includes('слишком большой') || error.message.includes('too large')) {
        errorMessage += '\n\nРекомендации:\n' +
          '1. Выберите режим "Разбить на части"\n' +
          '2. Уменьшите объем текста для анализа\n' +
          '3. Попробуйте другую модель, которая может обработать больший объем данных';
      } else if (error.message.includes('превышены ограничения') || error.message.includes('время ожидания')) {
        errorMessage += '\n\nРекомендации:\n' +
          '1. Выберите режим "Разбить на части"\n' +
          '2. Уменьшите объем текста\n' +
          '3. Повторите попытку позже\n' +
          '4. Попробуйте модель с меньшими ограничениями';
      }
      
      await bot.editMessageText(errorMessage, {
        chat_id: chatId,
        message_id: messageId
      });
      
      userState.currentState = 'main';
      setTimeout(async () => {
        await sendMessageWithRetry(chatId, 'Что вы хотите сделать дальше?', getMainMenu());
      }, 1000);
    }
    
    return;
  }
  
  // Обработка создания общего резюме
  if (data.startsWith('summarize:')) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Подготовка к созданию общего анализа...' });
    
    try {
      // Получаем состояние пользователя
      const userState = initUserState(chatId);
      
      // Проверяем наличие результатов анализа
      if (!userState.analysisResults || userState.analysisResults.length === 0) {
        throw new Error('Результаты анализа не найдены. Пожалуйста, повторите анализ.');
      }
      
      // Показываем пользователю меню выбора модели для общего анализа
      await bot.editMessageText('Выберите модель для создания общего анализа:', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: getModelSelectionMenu('summary_model:').reply_markup
      });
      
      // Сохраняем текущее состояние для дальнейшего процесса
      userState.currentState = 'summary_model_selection';
      
    } catch (error) {
      console.error('Ошибка при подготовке к общему анализу:', error);
      
      await bot.editMessageText(`❌ Произошла ошибка: ${error.message}\n\nПопробуйте повторить анализ.`, {
        chat_id: chatId,
        message_id: messageId
      });
      
      // Возвращаем пользователя в главное меню
      setTimeout(async () => {
        await sendMessageWithRetry(chatId, 'Что вы хотите сделать дальше?', getMainMenu());
      }, 1000);
    }
    
    return;
  }
  
  // Обработка выбора модели для общего анализа
  if (data.startsWith('summary_model:')) {
    const modelId = data.split(':')[1];
    await bot.answerCallbackQuery(callbackQuery.id, { text: `Выбрана модель: ${availableModels.find(m => m.id === modelId).name}` });
    
    // Создаем новое сообщение для отслеживания статуса
    const statusMessage = await bot.sendMessage(chatId, '⏳ Начинаем создание общего анализа по всем частям...');
    const statusMessageId = statusMessage.message_id;
    
    try {
      // Получаем состояние пользователя
      const userState = initUserState(chatId);
      
      // Проверяем наличие результатов анализа
      if (!userState.analysisResults || userState.analysisResults.length === 0) {
        throw new Error('Результаты анализа не найдены. Пожалуйста, повторите анализ.');
      }
      
      console.log(`Найдено ${userState.analysisResults.length} частей для создания анализа`);
      
      // Получаем промпт, использованный для анализа
      const originalPrompt = userState.analysisPrompt ? userState.analysisPrompt.text : 'Неизвестный промпт';
      
      // Создаем общий анализ, используя выбранную пользователем модель
      const summaryPath = await createSummaryFromResults(
        chatId, 
        statusMessageId, 
        modelId,
        userState.analysisResults, 
        originalPrompt
      );
      
      // Получаем название модели для отображения
      const selectedModel = availableModels.find(m => m.id === modelId);
      const modelName = selectedModel ? selectedModel.name : modelId;
      
      // Отправляем файл с результатом с более информативным описанием
      await bot.sendDocument(chatId, fs.createReadStream(summaryPath), {
        caption: `📊 ОБЩИЙ АНАЛИЗ\n\nОбъединение результатов анализа ${userState.analysisResults.length} частей текста\nМодель: ${modelName}`
      });
      
      // Обновляем статусное сообщение
      await bot.editMessageText('✅ Общий анализ успешно создан! Вы можете найти его выше.', {
        chat_id: chatId,
        message_id: statusMessageId
      });
      
      // Возвращаем пользователя в главное меню
      setTimeout(async () => {
        await sendMessageWithRetry(chatId, 'Что вы хотите сделать дальше?', getMainMenu());
      }, 1000);
      
    } catch (error) {
      console.error('Ошибка при создании общего анализа:', error);
      
      // Обновляем статусное сообщение
      await bot.editMessageText(`❌ Произошла ошибка при создании общего анализа: ${error.message}\n\nПопробуйте повторить анализ или обратитесь к разработчику.`, {
        chat_id: chatId,
        message_id: statusMessageId
      });
      
      // Возвращаем пользователя в главное меню
      setTimeout(async () => {
        await sendMessageWithRetry(chatId, 'Что вы хотите сделать дальше?', getMainMenu());
      }, 1000);
    }
    
    return;
  }
  
  // Обработка кнопки "Анализировать с выбранным промптом"
  if (data.startsWith('analyze:')) {
    const fileName = data.split(':')[1];
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Подготовка к анализу...' });
    
    // Устанавливаем путь к файлу для анализа
    const filePath = path.join(userOutputDir, fileName);
    
    if (!fs.existsSync(filePath)) {
      await bot.editMessageText('❌ Файл для анализа не найден. Пожалуйста, повторите конвертацию.', {
        chat_id: chatId,
        message_id: messageId
      });
      return;
    }
    
    // Получаем размер файла для отображения
    const fileStats = fs.statSync(filePath);
    const fileSizeKB = Math.round(fileStats.size / 1024);
    
    // Предлагаем выбор размера анализа
    await bot.editMessageText(`Файл "${fileName}" (${fileSizeKB} КБ) готов к анализу.\n\nВыберите вариант анализа:`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: getAnalysisSizeMenu(fileName).reply_markup
    });
    
    return;
  }
  
  // Обработка выбора размера анализа
  if (data.startsWith('analyze_full:') || data.startsWith('analyze_medium:') || data.startsWith('analyze_small:')) {
    const parts = data.split(':');
    const analysisType = parts[0];
    const fileName = parts[1];
    
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Подготовка к анализу...' });
    
    // Устанавливаем путь к файлу для анализа
    const filePath = path.join(userOutputDir, fileName);
    
    if (!fs.existsSync(filePath)) {
      await bot.editMessageText('❌ Файл для анализа не найден. Пожалуйста, повторите конвертацию.', {
        chat_id: chatId,
        message_id: messageId
      });
      return;
    }
    
    // Сохраняем путь к файлу и подготавливаем массив загруженных файлов
    userState.uploadedTextFiles = [filePath];
    userState.combinedTextPath = filePath;
    
    // Определяем размер части для анализа
    if (analysisType === 'analyze_small') {
      userState.analysisChunkSize = 300000; // ~300KB
    } else if (analysisType === 'analyze_medium') {
      userState.analysisChunkSize = 900000; // ~900KB
    } else {
      userState.analysisChunkSize = 1100000; // ~1.1MB
    }
    
    // Переходим к выбору промпта для анализа
    userState.currentState = 'analysis_prompt_selection';
    
    await bot.editMessageText('Выберите промпт для анализа или создайте новый:', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: getPromptsMenuForAnalysis(chatId).reply_markup
    });
    
    return;
  }
  
  await bot.answerCallbackQuery(callbackQuery.id);
});

// Обработка полученных файлов
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const fileId = msg.document.file_id;
  const fileName = msg.document.file_name;
  const userState = initUserState(chatId);
  
  // Проверяем, какой файл мы ожидаем по текущему состоянию
  if (userState.currentState === 'waiting_for_txt') {
    // Ожидаем .txt файлы для анализа
    if (!fileName.toLowerCase().endsWith('.txt')) {
      await sendMessageWithRetry(chatId, 'Пожалуйста, отправьте файл в формате .txt');
      return;
    }
    
    // Скачиваем файл
    try {
      const fileInfo = await getFileWithRetry(fileId);
      if (!fileInfo) {
        await sendMessageWithRetry(chatId, '❌ Не удалось получить информацию о файле. Попробуйте еще раз.');
        return;
      }
      
      const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
      
      // Создаем папку для пользователя, если её нет
      const userAnalysisDir = path.join(analysisDir, chatId.toString());
      if (!fs.existsSync(userAnalysisDir)) {
        fs.mkdirSync(userAnalysisDir, { recursive: true });
      }
      
      // Сохраняем файл
      const textFilePath = path.join(userAnalysisDir, fileName);
      await downloadFileWithRetry(fileUrl, textFilePath);
      
      // Добавляем путь к файлу в список загруженных
      userState.uploadedTextFiles.push(textFilePath);
      
      await sendMessageWithRetry(chatId, `✅ Файл "${fileName}" загружен (${userState.uploadedTextFiles.length} всего). Вы можете загрузить еще файлы или нажать "Завершить загрузку".`);
    } catch (err) {
      console.error('Ошибка при загрузке текстового файла:', err);
      await sendMessageWithRetry(chatId, `❌ Произошла ошибка при загрузке файла: ${err.message}`);
    }
    
    return;
  } else if (userState.currentState === 'waiting_for_file') {
    // Проверяем формат файла, когда ожидаем ZIP или RAR
    if (!fileName.toLowerCase().endsWith('.zip') && !fileName.toLowerCase().endsWith('.rar')) {
      await sendMessageWithRetry(chatId, 'Пожалуйста, отправьте файл в формате .zip или .rar');
      return;
    }
    
    // Если формат верный, продолжаем обработку
  } else {
    // Если бот не ожидает файла, но пользователь его отправляет - 
    // подсказываем вернуться к правильной последовательности действий
    if (fileName.toLowerCase().endsWith('.zip') || fileName.toLowerCase().endsWith('.rar')) {
      await sendMessageWithRetry(chatId, 'Сначала нажмите кнопку "📤 Загрузить ZIP или RAR архив", затем отправьте архив.', getMainMenu());
    } else if (fileName.toLowerCase().endsWith('.txt')) {
      await sendMessageWithRetry(chatId, 'Для загрузки .txt файлов сначала нажмите кнопку "📊 Анализ".', getMainMenu());
    } else {
      await sendMessageWithRetry(chatId, 'Я не знаю, что делать с этим файлом. Пожалуйста, воспользуйтесь меню для нужной операции.', getMainMenu());
    }
    userState.currentState = 'main';
    return;
  }
  
  // Убираем дублирующую проверку, т.к. она уже выполнена выше в блоке waiting_for_file
  // Обновляем состояние пользователя
  userState.currentState = 'processing';
  
  let statusMessage = await sendMessageWithRetry(chatId, 'Получен архив. Начинаю обработку...');
  const statusMessageId = statusMessage?.message_id;
  
  try {
    // Получаем информацию о файле
    const fileInfo = await getFileWithRetry(fileId);
    if (!fileInfo) {
      await updateStatusMessage(chatId, statusMessageId, '❌ Не удалось получить информацию о файле. Попробуйте еще раз.');
      userState.currentState = 'main';
      return;
    }
    
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
    
    // Путь для сохранения архива
    const zipPath = path.join(uploadsDir, fileName);
    
    // Создаем уникальную папку для этого пользователя/сообщения
    const userExtractDir = path.join(extractDir, chatId.toString(), Date.now().toString());
    const userOutputDir = path.join(outputDir, chatId.toString());
    
    if (!fs.existsSync(userExtractDir)) {
      fs.mkdirSync(userExtractDir, { recursive: true });
    }
    
    if (!fs.existsSync(userOutputDir)) {
      fs.mkdirSync(userOutputDir, { recursive: true });
    }
    
    // Скачиваем архив
    await updateStatusMessage(chatId, statusMessageId, '⬇️ Скачиваю архив...');
    
    try {
      // Скачиваем файл с повторными попытками
      await downloadFileWithRetry(fileUrl, zipPath);
      
      await updateStatusMessage(chatId, statusMessageId, '📂 Архив скачан. Извлекаю файлы...');
      
      // Распаковываем архив в зависимости от его типа
      let extractionSuccess = false;
      
      if (fileName.toLowerCase().endsWith('.zip')) {
        // Распаковываем ZIP архив
        try {
          const zip = new AdmZip(zipPath);
          zip.extractAllTo(userExtractDir, true);
          extractionSuccess = true;
        } catch (err) {
          console.error('Ошибка при распаковке ZIP архива:', err);
          await updateStatusMessage(chatId, statusMessageId, '❌ Ошибка при распаковке ZIP архива.');
        }
      } else if (fileName.toLowerCase().endsWith('.rar')) {
        // Распаковываем RAR архив
        try {
          extractionSuccess = await extractRarArchive(zipPath, userExtractDir);
          if (!extractionSuccess) {
            await updateStatusMessage(chatId, statusMessageId, '❌ Ошибка при распаковке RAR архива.');
          }
        } catch (err) {
          console.error('Ошибка при распаковке RAR архива:', err);
          await updateStatusMessage(chatId, statusMessageId, '❌ Ошибка при распаковке RAR архива.');
        }
      }
      
      if (!extractionSuccess) {
        userState.currentState = 'main';
        await sendMessageWithRetry(chatId, 'Что вы хотите делать дальше?', getMainMenu());
        return;
      }
      
      await updateStatusMessage(chatId, statusMessageId, '🔍 Файлы извлечены. Ищу HTML-файлы...');
      
      // Ищем HTML-файлы в извлеченных данных
      const htmlFiles = findHtmlFiles(userExtractDir);
      
      if (htmlFiles.length === 0) {
        await updateStatusMessage(chatId, statusMessageId, '❌ HTML-файлы не найдены в архиве.');
        userState.currentState = 'main';
        await sendMessageWithRetry(chatId, 'Что вы хотите делать дальше?', getMainMenu());
        return;
      }
      
      await updateStatusMessage(chatId, statusMessageId, `🔄 Найдено ${htmlFiles.length} HTML-файлов. Начинаю конвертацию...`);
      
      // Обрабатываем каждый HTML-файл
      const results = [];
      const batchSize = 20; // Размер пакета для обновления сообщения
      let processedCount = 0;
      
      for (let i = 0; i < htmlFiles.length; i++) {
        const htmlFile = htmlFiles[i];
        const basename = path.basename(htmlFile, '.html');
        const outputPath = path.join(userOutputDir, `${basename}.json`);
        
        processedCount++;
        
        // Обновляем статус только для каждого пакета или последнего файла
        if (processedCount % batchSize === 0 || processedCount === htmlFiles.length) {
          const progressPercent = Math.round((processedCount / htmlFiles.length) * 100);
          await updateStatusMessage(
            chatId, 
            statusMessageId, 
            `🔄 Конвертация: ${progressPercent}% (${processedCount}/${htmlFiles.length})`
          );
        }
        
        try {
          processSingleFile(htmlFile, outputPath);
          if (fs.existsSync(outputPath)) {
            results.push(outputPath);
          }
        } catch (err) {
          console.error(`Ошибка при обработке файла ${basename}:`, err);
          // Продолжаем процесс даже при ошибке с одним файлом
        }
      }
      
      // Создаем итоговый текстовый файл вместо отправки каждого JSON отдельно
      await updateStatusMessage(chatId, statusMessageId, `✅ Конвертация завершена. Создаю итоговый файл...`);
      
      if (results.length > 0) {
        // Шаг 1: Объединяем все JSON файлы в один массив
        let allMessages = [];
        
        for (const jsonFilePath of results) {
          try {
            const jsonContent = fs.readFileSync(jsonFilePath, 'utf8');
            const messages = JSON.parse(jsonContent);
            allMessages = allMessages.concat(messages);
          } catch (err) {
            console.error(`Ошибка при обработке файла ${jsonFilePath}:`, err);
          }
        }
        
        console.log(`Всего сообщений: ${allMessages.length}`);
        
        // Шаг 2: Сортировка сообщений по ID
        allMessages.sort((a, b) => {
          return parseInt(a.id) - parseInt(b.id);
        });
        
        // Шаг 3: Форматирование сообщений (по логике из converter.js)
        // Переменная для хранения предыдущей даты
        let previousDate = '';
        
        // Массив для хранения отформатированных сообщений
        const formattedMessagesArray = [];
        
        // Счетчики для отладки
        let emptySeparatorsAdded = 0;
        let messagesWithoutText = 0;
        
        // Обработка каждого сообщения
        allMessages.forEach(message => {
          // Пропускаем сообщения без текста или с пустым текстом
          if (!message.text || message.text.trim() === '') {
            messagesWithoutText++;
            return;
          }
          
          // Заменяем имена отправителей
          let sender = message.sender;
          if (sender && sender.includes(' ')) {
            // Берем только вторую часть имени (фамилию) для любого имени с пробелом
            sender = sender.split(' ')[1];
          } else if (sender === 'Вы') {
            sender = 'Андрей';
          }
          
          // Извлекаем дату из строки даты
          let currentDate = '';
          
          // Обрабатываем разные форматы даты
          if (message.date) {
            // Выделяем часть даты без времени
            let dateStr = message.date;
            if (dateStr.includes('в')) {
              // Из формата "Вы, 17 июн 2018 в 16:53:48" или "17 июн 2018 в 16:53:25"
              // Берем только "17 июн 2018"
              dateStr = dateStr.split('в')[0].trim();
              if (dateStr.startsWith('Вы, ')) {
                dateStr = dateStr.substring(4).trim(); // Убираем "Вы, "
              }
            }
            currentDate = dateStr;
          }
          
          // Проверяем, изменился ли день
          if (currentDate && previousDate && currentDate !== previousDate) {
            // Если день изменился, добавляем разделитель для четкого визуального отделения
            formattedMessagesArray.push('');
            formattedMessagesArray.push(`${currentDate}`);
            formattedMessagesArray.push('');
            emptySeparatorsAdded++;
          }
          
          // Добавляем сообщение в массив
          formattedMessagesArray.push(`${sender}   ${message.text}`);
          
          // Сохраняем текущую дату как предыдущую для следующего сообщения
          if (currentDate) {
            previousDate = currentDate;
          }
        });
        
        // Соединяем все сообщения с переносами строк
        const formattedMessages = formattedMessagesArray.join('\n');
        
        // Отладочная информация
        console.log(`Добавлено разделителей дней: ${emptySeparatorsAdded}`);
        console.log(`Пропущено сообщений без текста: ${messagesWithoutText}`);
        
        // Путь к итоговому файлу
        const outputBaseName = path.basename(fileName, '.zip');
        const finalOutputPath = path.join(userOutputDir, `${outputBaseName}.txt`);
        
        // Сохраняем итоговый файл
        fs.writeFileSync(finalOutputPath, formattedMessages, 'utf8');
        
        // Отправляем только итоговый файл
        await updateStatusMessage(chatId, statusMessageId, `✅ Обработка завершена. Отправляю результаты...`);
        
        try {
          // Если выбран промпт, показываем кнопку для анализа
          const prompts = getUserPrompts(chatId);
          let replyMarkup = null;
          
          if (userState.selectedPrompt !== null && prompts.length > userState.selectedPrompt) {
            // Создаем кнопку для анализа текста с выбранным промптом
            replyMarkup = {
              inline_keyboard: [
                [{ text: '📊 Анализировать с выбранным промптом', callback_data: `analyze:${path.basename(finalOutputPath)}` }]
              ]
            };
          }
          
          // Отправляем оригинальный объединенный файл
          await bot.sendDocument(chatId, fs.createReadStream(finalOutputPath), {
            caption: `Результат обработки (${allMessages.length} сообщений)`,
            reply_markup: replyMarkup
          });
          
          // Показываем модель, если выбрана
          const modelText = userState.selectedModel 
            ? `\n\nВыбрана модель: ${availableModels.find(m => m.id === userState.selectedModel).name}`
            : '';
            
          const promptText = userState.selectedPrompt !== null && prompts.length > userState.selectedPrompt
            ? `\nВыбран промпт: ${prompts[userState.selectedPrompt].name}`
            : '';
          
          await updateStatusMessage(chatId, statusMessageId, `✅ Готово! Файл с результатами отправлен.${modelText}${promptText}`);
          
          // Возвращаем пользователя в главное меню
          userState.currentState = 'main';
          setTimeout(async () => {
            await sendMessageWithRetry(chatId, 'Что вы хотите сделать дальше?', getMainMenu());
          }, 1000);
          
        } catch (err) {
          console.error('Ошибка при отправке итогового файла:', err);
          await updateStatusMessage(chatId, statusMessageId, `⚠️ Не удалось отправить итоговый файл: ${err.message}`);
          userState.currentState = 'main';
          setTimeout(async () => {
            await sendMessageWithRetry(chatId, 'Что вы хотите сделать дальше?', getMainMenu());
          }, 1000);
        }
      } else {
        await updateStatusMessage(chatId, statusMessageId, '❌ Не удалось создать ни одного результата. Возможно, в файлах нет нужной информации.');
        userState.currentState = 'main';
        setTimeout(async () => {
          await sendMessageWithRetry(chatId, 'Что вы хотите сделать дальше?', getMainMenu());
        }, 1000);
      }
      
      // Чистим временные файлы
      setTimeout(() => {
        try {
          if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
          deleteDirectory(userExtractDir);
        } catch (err) {
          console.error('Ошибка при удалении временных файлов:', err);
        }
      }, 5000);
      
    } catch (err) {
      console.error('Ошибка при обработке архива:', err);
      await updateStatusMessage(chatId, statusMessageId, `❌ Произошла ошибка при обработке архива: ${err.message}`);
      userState.currentState = 'main';
      setTimeout(async () => {
        await sendMessageWithRetry(chatId, 'Что вы хотите сделать дальше?', getMainMenu());
      }, 1000);
    }
    
  } catch (err) {
    console.error('Ошибка:', err);
    await updateStatusMessage(chatId, statusMessageId, `❌ Произошла ошибка: ${err.message}`);
    userState.currentState = 'main';
    setTimeout(async () => {
      await sendMessageWithRetry(chatId, 'Что вы хотите сделать дальше?', getMainMenu());
    }, 1000);
  }
});

// Функция для поиска HTML-файлов в директории (рекурсивно)
function findHtmlFiles(dir) {
  let results = [];
  
  const items = fs.readdirSync(dir);
  
  for (const item of items) {
    const itemPath = path.join(dir, item);
    const stat = fs.statSync(itemPath);
    
    if (stat.isDirectory()) {
      results = results.concat(findHtmlFiles(itemPath));
    } else if (item.toLowerCase().endsWith('.html')) {
      results.push(itemPath);
    }
  }
  
  return results;
}

// Функция для удаления директории с содержимым
function deleteDirectory(dir) {
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(file => {
      const curPath = path.join(dir, file);
      
      if (fs.lstatSync(curPath).isDirectory()) {
        // Рекурсивное удаление поддиректории
        deleteDirectory(curPath);
      } else {
        // Удаление файла
        fs.unlinkSync(curPath);
      }
    });
    
    fs.rmdirSync(dir);
  }
}

// Хранилище для отслеживания последних отправленных сообщений
const messageTracker = new Map();

// Функция для отправки сообщения с повторными попытками
async function sendMessageWithRetry(chatId, text, options = {}, retries = MAX_RETRIES) {
  // Создаем уникальный ключ для этого сообщения
  const messageKey = `${chatId}_${text.substring(0, 50)}`;
  const now = Date.now();
  
  // Проверяем, не было ли такое же сообщение отправлено недавно
  if (messageTracker.has(messageKey)) {
    const lastSentTime = messageTracker.get(messageKey);
    // Если сообщение отправлено менее 2 секунд назад, пропускаем повторную отправку
    if (now - lastSentTime < 2000) {
      console.log(`Пропуск дублирующего сообщения для ${chatId}: "${text.substring(0, 50)}..."`);
      return null;
    }
  }
  
  // Проверка длины сообщения и его обрезка при необходимости
  const maxTelegramMsgLength = 4000; // Максимальная длина сообщения в Telegram (с запасом)
  let safeText = text;
  
  if (text && text.length > maxTelegramMsgLength) {
    console.warn(`Сообщение слишком длинное (${text.length} символов). Обрезаем до ${maxTelegramMsgLength} символов.`);
    safeText = text.substring(0, maxTelegramMsgLength - 100) + "...\n\n[Сообщение слишком длинное и было обрезано]";
  }
  
  try {
    const result = await bot.sendMessage(chatId, safeText, options);
    // Сохраняем время отправки сообщения
    messageTracker.set(messageKey, now);
    // Очистка старых записей из трекера
    setTimeout(() => messageTracker.delete(messageKey), 10000);
    return result;
  } catch (error) {
    if (error.description && error.description.includes('MESSAGE_TOO_LONG')) {
      console.error('Ошибка MESSAGE_TOO_LONG даже после обрезки. Отправляем сокращенную версию.');
      // Если сообщение всё ещё слишком длинное, отправляем только базовую информацию
      const result = await bot.sendMessage(chatId, "[Сообщение слишком длинное для отображения. Обратитесь к разработчику.]", options);
      messageTracker.set(messageKey, now);
      return result;
    }
    
    if (retries > 0) {
      console.log(`Ошибка при отправке сообщения. Повторная попытка (осталось ${retries}): ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return sendMessageWithRetry(chatId, safeText, options, retries - 1);
    } else {
      console.error('Не удалось отправить сообщение после нескольких попыток:', error);
      return null;
    }
  }
}

// Функция для обновления статусного сообщения с проверкой длины
async function updateStatusMessage(chatId, messageId, text, retries = MAX_RETRIES) {
  if (!messageId) return;
  
  // Защита от обновления старых сообщений
  const now = Date.now();
  const messageKey = `status_${chatId}_${messageId}`;
  
  // Проверяем, было ли сообщение недавно обновлено
  if (messageTracker.has(messageKey)) {
    const lastUpdateTime = messageTracker.get(messageKey);
    if (now - lastUpdateTime < 1000) { // Интервал 1 секунда
      console.log(`Пропуск частого обновления статусного сообщения ${messageId}`);
      return null;
    }
  }
  
  // Проверка длины сообщения и его обрезка при необходимости
  const maxTelegramMsgLength = 4000; // Максимальная длина сообщения в Telegram (с запасом)
  let safeText = text;
  
  if (text && text.length > maxTelegramMsgLength) {
    console.warn(`Сообщение для обновления слишком длинное (${text.length} символов). Обрезаем до ${maxTelegramMsgLength} символов.`);
    safeText = text.substring(0, maxTelegramMsgLength - 100) + "...\n\n[Сообщение слишком длинное и было обрезано]";
  }
  
  try {
    const result = await bot.editMessageText(safeText, {
      chat_id: chatId,
      message_id: messageId
    });
    
    // Записываем время обновления
    messageTracker.set(messageKey, now);
    
    return result;
  } catch (error) {
    // Особая обработка для ошибки "message to edit not found"
    if (error.description && (
        error.description.includes('message to edit not found') || 
        error.description.includes('message is not modified'))) {
      console.log(`Сообщение ${messageId} не найдено или не изменено, пропуск обновления`);
      return null;
    }
    
    if (error.description && error.description.includes('MESSAGE_TOO_LONG')) {
      console.error('Ошибка MESSAGE_TOO_LONG даже после обрезки при обновлении сообщения.');
      // Если сообщение всё ещё слишком длинное, пытаемся обновить с минимальным текстом
      try {
        return await bot.editMessageText("[Сообщение слишком длинное для отображения]", {
          chat_id: chatId,
          message_id: messageId
        });
      } catch (innerError) {
        console.error('Не удалось обновить даже с минимальным текстом:', innerError.message);
        return null;
      }
    }
    
    if (retries > 0) {
      console.log(`Ошибка при обновлении сообщения. Повторная попытка (осталось ${retries}): ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return updateStatusMessage(chatId, messageId, safeText, retries - 1);
    } else {
      console.error('Не удалось обновить сообщение после нескольких попыток:', error);
      return null;
    }
  }
}

// Функция для получения информации о файле с повторными попытками
async function getFileWithRetry(fileId, retries = MAX_RETRIES) {
  try {
    return await bot.getFile(fileId);
  } catch (error) {
    if (retries > 0) {
      console.log(`Ошибка при получении информации о файле. Повторная попытка (осталось ${retries}): ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return getFileWithRetry(fileId, retries - 1);
    } else {
      console.error('Не удалось получить информацию о файле после нескольких попыток:', error);
      return null;
    }
  }
}

// Функция для скачивания файла с повторными попытками
function downloadFileWithRetry(url, destination, retries = MAX_RETRIES) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const file = fs.createWriteStream(destination);
    
    const request = https.get(url, function(response) {
      response.pipe(file);
      
      file.on('finish', function() {
        file.close(() => resolve());
      });
      
      file.on('error', function(err) {
        fs.unlinkSync(destination);
        
        if (retries > 0) {
          console.log(`Ошибка при скачивании файла. Повторная попытка (осталось ${retries}): ${err.message}`);
          setTimeout(() => {
            downloadFileWithRetry(url, destination, retries - 1)
              .then(resolve)
              .catch(reject);
          }, RETRY_DELAY);
        } else {
          console.error('Не удалось скачать файл после нескольких попыток:', err);
          reject(err);
        }
      });
    });
    
    request.on('error', function(err) {
      if (fs.existsSync(destination)) {
        fs.unlinkSync(destination);
      }
      
      if (retries > 0) {
        console.log(`Ошибка запроса при скачивании файла. Повторная попытка (осталось ${retries}): ${err.message}`);
        setTimeout(() => {
          downloadFileWithRetry(url, destination, retries - 1)
            .then(resolve)
            .catch(reject);
        }, RETRY_DELAY);
      } else {
        console.error('Не удалось выполнить запрос после нескольких попыток:', err);
        reject(err);
      }
    });
  });
}

// Функция для отправки файлов с повторными попытками (обновленная - сохраняем для возможного использования)
async function sendFilesWithRetry(chatId, filePaths, retries = MAX_RETRIES) {
  try {
    // Если нужно отправить много файлов, лучше отправить архив
    if (filePaths.length > 10) {
      const zipPath = path.join(uploadsDir, `results_${Date.now()}.zip`);
      const zip = new AdmZip();
      
      // Добавляем файлы в архив
      filePaths.forEach(filePath => {
        if (fs.existsSync(filePath)) {
          zip.addLocalFile(filePath);
        }
      });
      
      // Сохраняем архив
      zip.writeZip(zipPath);
      
      // Отправляем архив
      return await bot.sendDocument(chatId, fs.createReadStream(zipPath), {
        caption: `Результаты обработки (${filePaths.length} файлов)`
      });
    }
    
    // Для меньшего количества файлов используем стандартный подход
    const media = filePaths.map(filePath => ({
      type: 'document',
      media: fs.createReadStream(filePath),
      caption: `Результат обработки: ${path.basename(filePath)}`
    }));
    
    // Если файл только один
    if (media.length === 1) {
      return await bot.sendDocument(chatId, media[0].media, {
        caption: media[0].caption
      });
    } 
    // Если файлов несколько, отправляем как медиагруппу
    else {
      return await bot.sendMediaGroup(chatId, media);
    }
  } catch (error) {
    if (retries > 0) {
      console.log(`Ошибка при отправке файлов. Повторная попытка (осталось ${retries}): ${error.message}`);
      // Увеличиваем задержку при ошибке Too Many Requests
      const delay = error.message.includes('Too Many Requests') 
        ? extractRetryAfter(error.message) * 1000 + 500 // Добавляем дополнительные 0.5 секунды
        : RETRY_DELAY;
      
      await new Promise(resolve => setTimeout(resolve, delay));
      return sendFilesWithRetry(chatId, filePaths, retries - 1);
    } else {
      console.error('Не удалось отправить файлы после нескольких попыток:', error);
      
      // В крайнем случае, пробуем отправить по одному
      try {
        for (const filePath of filePaths) {
          if (fs.existsSync(filePath)) {
            await bot.sendDocument(chatId, fs.createReadStream(filePath), {
              caption: `Результат обработки: ${path.basename(filePath)}`
            });
            // Увеличенная пауза между отправками
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
        return true;
      } catch (err) {
        console.error('Не удалось отправить файлы даже по одному:', err);
        return null;
      }
    }
  }
}

// Вспомогательная функция для извлечения времени ожидания из сообщения об ошибке
function extractRetryAfter(errorMessage) {
  const match = errorMessage.match(/retry after (\d+)/i);
  return match ? parseInt(match[1], 10) : 10; // По умолчанию 10 секунд
}

// Функция для получения меню промптов для анализа
function getPromptsMenuForAnalysis(chatId) {
  const userPromptsFile = path.join(promptsDir, `${chatId}.json`);
  let prompts = [];
  
  if (fs.existsSync(userPromptsFile)) {
    try {
      prompts = JSON.parse(fs.readFileSync(userPromptsFile, 'utf8'));
    } catch (err) {
      console.error('Ошибка при чтении файла промптов:', err);
    }
  }
  
  const inlineKeyboard = [];
  
  // Добавляем существующие промпты
  prompts.forEach((prompt, index) => {
    // Ограничиваем длину имени промпта для безопасного отображения
    const promptName = prompt.name.length > 20 ? prompt.name.substring(0, 20) + '...' : prompt.name;
    inlineKeyboard.push([
      { text: promptName, callback_data: `analysis_prompt_select:${index}` }
    ]);
  });
  
  // Добавляем кнопку для создания нового промпта
  inlineKeyboard.push([{ text: '➕ Создать новый промпт', callback_data: 'analysis_prompt_add' }]);
  
  return {
    reply_markup: {
      inline_keyboard: inlineKeyboard
    }
  };
}

// Функция для объединения текстовых файлов
async function combineTextFiles(chatId, filePaths) {
  if (!filePaths || filePaths.length === 0) return null;
  
  try {
    const userAnalysisDir = path.join(analysisDir, chatId.toString());
    const combinedFilePath = path.join(userAnalysisDir, `combined_${Date.now()}.txt`);
    
    // Создаем объединенный файл
    let combinedContent = '';
    
    // Перебираем все файлы и добавляем их содержимое
    for (const filePath of filePaths) {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        
        // Добавляем разделитель между файлами
        if (combinedContent.length > 0) {
          combinedContent += '\n\n=== НОВЫЙ ФАЙЛ ===\n\n';
        }
        
        combinedContent += content;
      }
    }
    
    // Сохраняем объединенный контент
    fs.writeFileSync(combinedFilePath, combinedContent, 'utf8');
    
    return combinedFilePath;
  } catch (err) {
    console.error('Ошибка при объединении текстовых файлов:', err);
    return null;
  }
}

// Функция для анализа текста с помощью LLM через OpenRouter API
async function analyzeTextWithLLM(modelId, prompt) {
  try {
    console.log(`Отправка запроса к модели ${modelId}`);
    console.log(`Длина промпта: ${prompt.length} символов`);
    
    // Проверка на очень большие промпты
    if (prompt.length > 1000000) {
      console.warn(`ВНИМАНИЕ: Промпт очень большой (${prompt.length} символов). API может не обработать такой объем данных.`);
    }
    
    // Запрос к OpenRouter API - отправляем промпт как есть, без обрезки
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: modelId,
      messages: [
        { role: 'user', content: prompt }
      ]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openrouterApiKey}`,
        'HTTP-Referer': 'https://t.me', // Домен телеграм бота
        'X-Title': 'Telegram Chat Analysis Bot' // Название приложения
      },
      // Увеличиваем таймаут для больших запросов
      timeout: 300000 // 5 минут
    });
    
    // Логируем детальную информацию о ответе
    console.log('Получен ответ от OpenRouter API:');
    console.log('Статус ответа:', response.status);
    console.log('Заголовки ответа:', response.headers);
    console.log('Данные ответа:', JSON.stringify(response.data).substring(0, 500) + '...');
    
    // Проверяем наличие необходимых данных в ответе
    if (!response.data || !response.data.choices || !response.data.choices[0] || !response.data.choices[0].message) {
      console.error('Получен некорректный ответ от API:', response.data);
      throw new Error('API вернул некорректный ответ. Возможно, промпт слишком большой для обработки.');
    }
    
    console.log('Модель:', response.data.model || 'Не указана');
    console.log('Статистика использования:', response.data.usage || 'Не предоставлена');
    
    // Извлекаем ответ модели с проверками на существование
    const assistantMessage = response.data.choices[0]?.message?.content;
    
    if (!assistantMessage) {
      throw new Error('Модель не вернула текстовый ответ. Возможно, превышены ограничения API.');
    }
    
    return {
      model: response.data.model || modelId,
      response: assistantMessage,
      usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    // Улучшенная обработка ошибок
    console.error('Ошибка при запросе к OpenRouter API:', error);
    
    // Проверяем тип ошибки для более информативных сообщений
    if (error.response) {
      // Сервер ответил с статус-кодом за пределами 2xx
      console.error('Ответ сервера с ошибкой:', {
        status: error.response.status,
        headers: error.response.headers,
        data: error.response.data
      });
      
      if (error.response.status === 413 || (error.response.data && error.response.data.error && 
          error.response.data.error.message && error.response.data.error.message.includes('too large'))) {
        throw new Error(`Промпт слишком большой для обработки API (${prompt.length} символов). Попробуйте уменьшить размер текста.`);
      }
      
      throw new Error(error.response.data?.error?.message || `Ошибка API (код ${error.response.status}): ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      // Запрос был сделан, но ответ не получен
      if (error.code === 'ECONNABORTED') {
        throw new Error(`Превышено время ожидания ответа от API. Возможно, промпт слишком большой (${prompt.length} символов).`);
      }
      throw new Error(`Нет ответа от сервера: ${error.message}`);
    } else {
      // Что-то пошло не так при настройке запроса
      throw new Error(`Ошибка при подготовке запроса: ${error.message}`);
    }
  }
}

// Функция для расчета стоимости запроса на основе использованных токенов и модели
function calculateRequestCost(modelId, promptTokens, completionTokens) {
  // Подробное логирование для отладки
  console.log('-------- РАСЧЕТ СТОИМОСТИ --------');
  console.log(`Модель ID: ${modelId}`);
  console.log(`Токены промпта: ${promptTokens}`);
  console.log(`Токены ответа: ${completionTokens}`);
  
  // Проверяем, что количество токенов - числа
  if (typeof promptTokens !== 'number' || isNaN(promptTokens)) {
    console.log(`ОШИБКА: Количество токенов промпта не является числом: ${promptTokens}`);
    promptTokens = 0;
  }
  
  if (typeof completionTokens !== 'number' || isNaN(completionTokens)) {
    console.log(`ОШИБКА: Количество токенов ответа не является числом: ${completionTokens}`);
    completionTokens = 0;
  }
  
  // Находим модель в списке
  const model = availableModels.find(m => m.id === modelId);
  if (!model) {
    console.log(`ОШИБКА: Модель с ID ${modelId} не найдена в списке доступных моделей`);
    return 'н/д (модель не найдена)';
  }
  
  console.log(`Название модели: ${model.name}`);
  console.log(`Цена за токены промпта: $${model.input_price}/M`);
  console.log(`Цена за токены ответа: $${model.output_price}/M`);
  
  // Рассчитываем стоимость для входных и выходных токенов
  const inputCost = (promptTokens / 1000000) * model.input_price;
  const outputCost = (completionTokens / 1000000) * model.output_price;
  
  console.log(`Расчет стоимости промпта: (${promptTokens} / 1000000) * ${model.input_price} = $${inputCost.toFixed(5)}`);
  console.log(`Расчет стоимости ответа: (${completionTokens} / 1000000) * ${model.output_price} = $${outputCost.toFixed(5)}`);
  
  // Общая стоимость
  const totalCost = inputCost + outputCost;
  console.log(`Общая стоимость: $${inputCost.toFixed(5)} + $${outputCost.toFixed(5)} = $${totalCost.toFixed(5)}`);
  
  // Форматируем с округлением до 5 знаков после запятой
  const formattedCost = totalCost.toFixed(5);
  console.log(`Отформатированная общая стоимость: $${formattedCost}`);
  console.log('-------- КОНЕЦ РАСЧЕТА --------');
  
  return {
    inputCost: `$${inputCost.toFixed(5)}`,
    outputCost: `$${outputCost.toFixed(5)}`,
    totalCost: `$${formattedCost}`
  };
}

// Функция для создания HTML результата анализа
function createHtmlResult(result, metadata) {
  // Логируем входные данные для отладки
  console.log('-------- ДАННЫЕ ДЛЯ HTML ОТЧЕТА --------');
  console.log('Метаданные:', metadata);
  console.log('Данные об использовании:', result.usage);
  
  // Рассчитываем стоимость запроса
  const promptTokens = result.usage && result.usage.prompt_tokens ? 
    parseInt(result.usage.prompt_tokens) : 0;
  
  const completionTokens = result.usage && result.usage.completion_tokens ? 
    parseInt(result.usage.completion_tokens) : 0;
  
  const totalTokens = result.usage && result.usage.total_tokens ? 
    parseInt(result.usage.total_tokens) : 0;
  
  console.log(`Токены промпта для расчета: ${promptTokens}`);
  console.log(`Токены ответа для расчета: ${completionTokens}`);
  console.log(`Общее количество токенов: ${totalTokens}`);
  
  const costs = calculateRequestCost(metadata.model, promptTokens, completionTokens);
  console.log(`Рассчитанные стоимости:`, costs);
  
  // Добавляем дополнительную информацию для частичного анализа или общего резюме
  let additionalInfo = '';
  
  if (metadata.isPartial) {
    additionalInfo = `<div class="part-info">
      <div class="part-badge">Часть ${metadata.partNumber} из ${metadata.totalParts}</div>
    </div>`;
  } else if (metadata.isSummary) {
    // Показываем информацию о количестве использованных частей
    const partsInfo = metadata.validParts && metadata.validParts !== metadata.totalParts ? 
      `${metadata.validParts} из ${metadata.totalParts}` : 
      `${metadata.totalParts}`;
      
    additionalInfo = `<div class="summary-info">
      <div class="summary-badge">Общее резюме (объединение ${partsInfo} частей)</div>
    </div>`;
  }
  
  // Добавляем стили для новых элементов
  const additionalStyles = `
    .part-info, .summary-info {
      margin: 10px 0;
      padding: 10px;
      border-radius: var(--border-radius);
      background-color: #f5f5f5;
      text-align: center;
    }
    
    .part-badge {
      display: inline-block;
      padding: 5px 15px;
      background-color: var(--accent-color);
      color: white;
      border-radius: 50px;
      font-weight: bold;
    }
    
    .summary-badge {
      display: inline-block;
      padding: 5px 15px;
      background: linear-gradient(135deg, #4CAF50, #8BC34A);
      color: white;
      border-radius: 50px;
      font-weight: bold;
    }
  `;

  const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Результат анализа</title>
  <style>
    :root {
      --primary-color: #4863A0;
      --accent-color: #5D8AA8;
      --light-bg: #f8f9fa;
      --border-radius: 8px;
      --box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
      --transition: all 0.3s ease;
    }
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'Roboto', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      line-height: 1.6;
      color: #333;
      background-color: #f5f7fa;
      padding: 0;
      margin: 0;
    }
    
    .container {
      max-width: 900px;
      margin: 20px auto;
      padding: 0 20px;
    }
    
    .card {
      background-color: #fff;
      border-radius: var(--border-radius);
      box-shadow: var(--box-shadow);
      overflow: hidden;
      margin-bottom: 30px;
      transition: var(--transition);
    }
    
    .card:hover {
      box-shadow: 0 5px 15px rgba(0, 0, 0, 0.15);
    }
    
    .header {
      background: linear-gradient(135deg, var(--primary-color) 0%, var(--accent-color) 100%);
      color: white;
      padding: 25px;
      position: relative;
    }
    
    .header::after {
      content: '';
      position: absolute;
      bottom: -10px;
      left: 0;
      right: 0;
      height: 10px;
      background: linear-gradient(to bottom, rgba(0,0,0,0.1), transparent);
    }
    
    .metadata {
      background-color: #ffffff;
      padding: 20px;
      border-bottom: 1px solid #eee;
      font-size: 14px;
      color: #555;
    }
    
    .metadata-item {
      margin-bottom: 8px;
      display: flex;
      align-items: flex-start;
    }
    
    .metadata-label {
      min-width: 100px;
      font-weight: 600;
      color: var(--primary-color);
    }
    
    .timestamp {
      text-align: right;
      font-size: 12px;
      color: #888;
      margin-top: 10px;
    }
    
    .content-section {
      padding: 25px;
    }
    
    .section-title {
      color: var(--primary-color);
      font-size: 18px;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
    }
    
    .section-title::before {
      content: '';
      display: inline-block;
      width: 4px;
      height: 18px;
      background-color: var(--accent-color);
      margin-right: 10px;
      border-radius: 2px;
    }
    
    .response {
      padding: 20px;
      background-color: var(--light-bg);
      border-radius: var(--border-radius);
      border-left: 4px solid var(--accent-color);
      margin-bottom: 20px;
      font-size: 15px;
    }
    
    .usage {
      background-color: #fff;
      padding: 20px;
      border-radius: var(--border-radius);
      border: 1px solid #eee;
    }
    
    .usage-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 15px;
      margin-bottom: 20px;
    }
    
    .usage-item {
      padding: 15px;
      background-color: var(--light-bg);
      border-radius: var(--border-radius);
      text-align: center;
    }
    
    .usage-value {
      font-size: 18px;
      font-weight: 600;
      color: var(--primary-color);
      margin-top: 5px;
    }
    
    .usage-label {
      font-size: 12px;
      color: #666;
    }
    
    .cost {
      margin-top: 20px;
      padding: 15px;
      background-color: var(--light-bg);
      border-radius: var(--border-radius);
    }
    
    .cost-title {
      font-weight: 600;
      color: #e74c3c;
      margin-bottom: 10px;
    }
    
    .cost-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      font-size: 12px;
      color: #666;
    }
    
    .cost-item {
      padding: 8px;
      background-color: white;
      border-radius: var(--border-radius);
      text-align: center;
    }
    
    .cost-value {
      font-weight: 600;
      color: #555;
      margin-top: 5px;
    }
    
    h1 {
      color: white;
      font-size: 24px;
      margin-bottom: 5px;
    }
    
    h2 {
      font-size: 20px;
      margin-bottom: 20px;
    }
    
    pre {
      white-space: pre-wrap;
      word-wrap: break-word;
      font-family: 'Roboto Mono', monospace;
      line-height: 1.5;
    }
    
    ${additionalStyles}
    
    @media (max-width: 768px) {
      .usage-grid, .cost-grid {
        grid-template-columns: 1fr;
      }
      
      .container {
        padding: 10px;
      }
      
      .metadata-item {
        flex-direction: column;
      }
      
      .metadata-label {
        margin-bottom: 5px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <h1>Результат анализа текста</h1>
        <p>Обработано с использованием LLM</p>
      </div>
      
      ${additionalInfo}
      
      <div class="metadata">
        <div class="metadata-item">
          <div class="metadata-label">Модель:</div>
          <div>${metadata.model}</div>
        </div>
        <div class="metadata-item">
          <div class="metadata-label">Файл:</div>
          <div>${metadata.fileName}</div>
        </div>
        <div class="metadata-item">
          <div class="metadata-label">Промпт:</div>
          <div>${metadata.prompt}</div>
        </div>
        <div class="timestamp">
          Дата анализа: ${result.timestamp}
        </div>
      </div>
      
      <div class="content-section">
        <div class="section-title">Ответ модели</div>
        <div class="response">
          <pre>${result.response}</pre>
        </div>
        
        <div class="section-title">Статистика</div>
        <div class="usage">
          <div class="usage-grid">
            <div class="usage-item">
              <div class="usage-label">Токены промпта</div>
              <div class="usage-value">${promptTokens}</div>
            </div>
            <div class="usage-item">
              <div class="usage-label">Токены ответа</div>
              <div class="usage-value">${completionTokens}</div>
            </div>
            <div class="usage-item">
              <div class="usage-label">Всего токенов</div>
              <div class="usage-value">${totalTokens}</div>
            </div>
          </div>
          
          <div class="cost">
            <div class="cost-title">Стоимость запроса</div>
            <div class="cost-grid">
              <div class="cost-item">
                <div class="usage-label">Промпт</div>
                <div class="cost-value">${costs.inputCost}</div>
              </div>
              <div class="cost-item">
                <div class="usage-label">Ответ</div>
                <div class="cost-value">${costs.outputCost}</div>
              </div>
              <div class="cost-item">
                <div class="usage-label">Итого</div>
                <div class="cost-value">${costs.totalCost}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
  `;
  
  return html;
}

// Функция для безопасного отображения текста промпта (защита от слишком длинных сообщений)
function getSafePromptText(promptText) {
  const maxTelegramMsgLength = 4000; // Максимальная длина сообщения в Telegram (с запасом)
  
  if (!promptText || promptText.length <= maxTelegramMsgLength) {
    return promptText;
  }
  
  // Если текст слишком длинный, возвращаем обрезанную версию
  return promptText.substring(0, maxTelegramMsgLength - 200) + 
    '\n\n... [Текст слишком длинный, отображается сокращенная версия] ...';
}

// Функция для отправки промпта (либо как сообщение, либо как файл)
async function sendPromptToUser(chatId, promptName, promptText, messageId = null) {
  const maxTelegramMsgLength = 4000; // Максимальная длина сообщения в Telegram (с запасом)
  
  // Если текст относительно короткий, отправляем его как сообщение
  if (promptText.length <= maxTelegramMsgLength) {
    const message = `Выбран промпт: ${promptName}\n\n${promptText}`;
    
    if (messageId) {
      // Редактируем существующее сообщение
      return await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId
      });
    } else {
      // Отправляем новое сообщение
      return await sendMessageWithRetry(chatId, message);
    }
  } else {
    // Для длинных промптов создаем временный файл и отправляем его
    const tempFilePath = path.join(promptsDir, `temp_prompt_${Date.now()}.txt`);
    const fileContent = `Промпт: ${promptName}\n\n${promptText}`;
    
    fs.writeFileSync(tempFilePath, fileContent, 'utf8');
    
    if (messageId) {
      // Если мы пытались редактировать сообщение, сначала сообщаем, что промпт будет отправлен как файл
      await bot.editMessageText(`Промпт "${promptName}" слишком длинный для отображения. Отправляю его как файл...`, {
        chat_id: chatId,
        message_id: messageId
      });
    }
    
    // Отправляем файл
    await bot.sendDocument(chatId, fs.createReadStream(tempFilePath), {
      caption: `Промпт: ${promptName}`
    });
    
    // Удаляем временный файл после отправки
    setTimeout(() => {
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      } catch (err) {
        console.error('Ошибка при удалении временного файла промпта:', err);
      }
    }, 5000);
    
    return null;
  }
}

// Функция для разделения текста на части с сохранением целостности предложений
function splitTextIntoChunks(text, maxChunkSize = 900000) {
  // Если текст меньше максимального размера, возвращаем его как есть
  if (text.length <= maxChunkSize) {
    return [text];
  }
  
  console.log(`Разделение текста размером ${text.length} символов на части по ~${maxChunkSize} символов`);
  
  const chunks = [];
  let startIndex = 0;
  
  while (startIndex < text.length) {
    // Определяем конец части
    let endIndex = startIndex + maxChunkSize;
    
    // Если мы не дошли до конца текста, ищем границу предложения или параграфа
    if (endIndex < text.length) {
      // Проверяем, есть ли разделитель дня (новый день переписки)
      const dayDivider = text.lastIndexOf('', endIndex);
      
      // Ищем ближайшую точку, за которой следует пробел или новая строка
      const possibleEnd = text.lastIndexOf('. ', endIndex);
      const possibleEndNewline = text.lastIndexOf('.\n', endIndex);
      const paragraphEnd = text.lastIndexOf('\n\n', endIndex);
      
      // Выбираем наиболее подходящую точку окончания
      // Приоритет: разделитель дня > конец параграфа > конец предложения
      if (dayDivider > startIndex + maxChunkSize / 2) {
        // Заканчиваем на разделителе дней, чтобы не разрывать дни между чанками
        endIndex = dayDivider;
      } else if (paragraphEnd > startIndex + maxChunkSize / 2) {
        // Заканчиваем на разделителе параграфов
        endIndex = paragraphEnd + 2; // +2 для включения \n\n
      } else if (possibleEnd > startIndex + maxChunkSize / 2) {
        endIndex = possibleEnd + 1; // +1 чтобы включить точку
      } else if (possibleEndNewline > startIndex + maxChunkSize / 2) {
        endIndex = possibleEndNewline + 2; // +2 чтобы включить точку и перевод строки
      } else {
        // Если подходящей точки нет, ищем конец последнего слова
        const lastSpace = text.lastIndexOf(' ', endIndex);
        if (lastSpace > startIndex + maxChunkSize / 2) {
          endIndex = lastSpace + 1;
        }
        // Если и пробела нет, просто обрезаем по размеру
      }
    }
    
    // Создаем новую часть
    const chunk = text.substring(startIndex, endIndex);
    chunks.push(chunk);
    
    // Обновляем начальный индекс для следующей части
    startIndex = endIndex;
  }
  
  console.log(`Текст разделен на ${chunks.length} частей`);
  return chunks;
}

// Функция для получения меню с опциями размера анализа
function getAnalysisSizeMenu(fileName) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🚀 Полный анализ (1.1MB)', callback_data: `analyze_full:${fileName}` }],
        [{ text: '✅ Стандартный размер (900KB)', callback_data: `analyze_medium:${fileName}` }],
        [{ text: '🔍 Небольшой фрагмент (300KB)', callback_data: `analyze_small:${fileName}` }]
      ]
    }
  };
}

// Функция для анализа текста по частям
async function analyzeTextInChunks(chatId, messageId, modelId, prompt, textContent, maxTokensPerChunk = 900000) {
  try {
    // Инициализируем состояние пользователя
    const userState = initUserState(chatId);
    
    // Разделяем текст на части, учитывая ограничение на токены
    const chunks = splitTextIntoChunks(textContent, maxTokensPerChunk);
    
    console.log(`Текст разделен на ${chunks.length} частей для анализа`);
    
    // Массив для хранения результатов анализа каждой части
    const results = [];
    
    // Создаем папку для результатов частичного анализа
    const userAnalysisDir = path.join(analysisDir, chatId.toString());
    if (!fs.existsSync(userAnalysisDir)) {
      fs.mkdirSync(userAnalysisDir, { recursive: true });
    }
    
    // Для отслеживания прогресса
    const totalChunks = chunks.length;
    
    // Анализируем каждую часть последовательно
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkNumber = i + 1;
      
      try {
        // Обновляем сообщение о ходе выполнения
        await bot.editMessageText(`⏳ Анализ части ${chunkNumber}/${totalChunks}...\n\nРазмер части: ${Math.round(chunk.length / 1024)} КБ`, {
          chat_id: chatId,
          message_id: messageId
        });
        
        // Формируем промпт для конкретной части
        const partPrompt = `${prompt}\n\nВот текст для анализа (часть ${chunkNumber} из ${totalChunks}):\n${chunk}`;
        
        // Отправляем запрос к API
        const result = await analyzeTextWithLLM(modelId, partPrompt);
        
        // Сохраняем результат в HTML файл
        const partHtml = createHtmlResult(result, {
          model: modelId,
          prompt: prompt,
          fileName: `Часть ${chunkNumber} из ${totalChunks}`,
          isPartial: true,
          partNumber: chunkNumber,
          totalParts: totalChunks
        });
        
        // Путь для сохранения результата части
        const partResultPath = path.join(userAnalysisDir, `analysis_part_${chunkNumber}_of_${totalChunks}_${Date.now()}.html`);
        
        // Сохраняем HTML файл
        fs.writeFileSync(partResultPath, partHtml, 'utf8');
        
        // Добавляем результат в массив
        results.push({
          path: partResultPath,
          response: result.response,
          partNumber: chunkNumber
        });
        
        // Отправляем файл с результатом части пользователю
        await bot.sendDocument(chatId, fs.createReadStream(partResultPath), {
          caption: `Результат анализа части ${chunkNumber}/${totalChunks}`
        });
        
      } catch (error) {
        console.error(`Ошибка при анализе части ${chunkNumber}:`, error);
        
        // Отправляем сообщение об ошибке
        await bot.sendMessage(chatId, `❌ Ошибка при анализе части ${chunkNumber}: ${error.message}\n\nПродолжаем анализ следующих частей...`);
        
        // Добавляем информацию об ошибке в результат
        results.push({
          path: null,
          response: `Ошибка анализа: ${error.message}`,
          partNumber: chunkNumber,
          error: true
        });
      }
    }
    
    // Создаем обобщающий запрос, если есть хотя бы один успешный результат
    if (results.some(r => !r.error)) {
      // Обновляем сообщение
      await bot.editMessageText(`✅ Анализ ${totalChunks} частей завершен. Подготовка общего анализа...`, {
        chat_id: chatId,
        message_id: messageId
      });
      
      // Сохраняем результаты в состоянии пользователя для дальнейшего обобщения
      userState.analysisResults = results;
      userState.analysisPrompt = { text: prompt }; // Сохраняем и промпт для резюме
      userState.lastAnalysisModel = modelId; // Сохраняем модель
      
      // Кнопка для создания общего резюме - более явная с emoji
      const inlineKeyboard = {
        inline_keyboard: [
          [{ text: '🔄 Создать общий анализ по всем частям', callback_data: `summarize:${chatId}_${Date.now()}` }]
        ]
      };
      
      // Отправляем новое сообщение с кнопкой вместо обновления старого
      await bot.sendMessage(chatId, 
        `✅ Анализ всех ${totalChunks} частей успешно завершен!\n\n` +
        `Чтобы создать общий анализ, который объединит результаты всех ${totalChunks} частей в один документ, нажмите кнопку ниже:`, 
        { reply_markup: inlineKeyboard }
      );
      
      console.log(`Анализ по частям завершен, результаты сохранены: ${results.length} частей`);
      
      return true;
    } else {
      await bot.editMessageText(`❌ Не удалось успешно проанализировать ни одну часть текста.`, {
        chat_id: chatId,
        message_id: messageId
      });
      
      return false;
    }
  } catch (error) {
    console.error('Ошибка при мультичастном анализе:', error);
    throw error;
  }
}

// Функция для создания общего резюме на основе частичных результатов
async function createSummaryFromResults(chatId, messageId, modelId, results, originalPrompt) {
  try {
    // Обновляем сообщение о начале обобщения
    await bot.editMessageText(`⏳ Создание общего анализа по ${results.length} частям...`, {
      chat_id: chatId,
      message_id: messageId
    });
    
    // Фильтруем результаты для исключения ошибочных частей
    const validResults = results.filter(result => !result.error);
    console.log(`Из ${results.length} частей для обобщения используется ${validResults.length} частей (без ошибок)`);
    
    if (validResults.length === 0) {
      throw new Error('Нет успешно проанализированных частей для создания общего анализа.');
    }
    
    // Получаем название выбранной модели для отображения
    const selectedModel = availableModels.find(m => m.id === modelId);
    const modelName = selectedModel ? selectedModel.name : modelId;
    
    // Составляем промпт для обобщения
    let summaryPrompt = `${originalPrompt}\n\n`;

    // Добавляем информацию об общем количестве частей и количестве ошибочных частей
    if (results.length !== validResults.length) {
      summaryPrompt += `Примечание: анализируемый текст был разделен на ${results.length} частей, но ${results.length - validResults.length} частей не удалось проанализировать из-за ошибок. Вы работаете с ${validResults.length} доступными частями.\n\n`;
    } else {
      summaryPrompt += `Примечание: анализируемый текст был разделен на ${results.length} частей из-за большого объема.\n\n`;
    }

    summaryPrompt += `Ниже представлен полный текст для анализа, собранный из всех частей. Проанализируйте его согласно исходному запросу.\n\n`;
    
    // Добавляем результаты каждой части, но представляем их как единый текст для анализа
    validResults.forEach((result) => {
      summaryPrompt += `\n--- ЧАСТЬ ${result.partNumber} ---\n${result.response}\n`;
    });
    
    // Обновляем статус
    await bot.editMessageText(`⏳ Отправляем запрос на создание общего анализа (используется ${validResults.length} частей)...
Используется модель: ${modelName}`, {
      chat_id: chatId,
      message_id: messageId
    });
    
    // Отправляем запрос на обобщение, используя выбранную модель
    const summaryResult = await analyzeTextWithLLM(modelId, summaryPrompt);
    
    // Создаем папку для результата
    const userAnalysisDir = path.join(analysisDir, chatId.toString());
    if (!fs.existsSync(userAnalysisDir)) {
      fs.mkdirSync(userAnalysisDir, { recursive: true });
    }
    
    // Создаем HTML с обобщенным результатом
    const summaryHtml = createHtmlResult(summaryResult, {
      model: modelId,
      prompt: originalPrompt,
      fileName: `Общий анализ ${validResults.length} из ${results.length} частей`,
      isSummary: true,
      totalParts: results.length,
      validParts: validResults.length
    });
    
    // Путь для сохранения итогового результата
    const summaryPath = path.join(userAnalysisDir, `analysis_summary_of_${validResults.length}_of_${results.length}_parts_${Date.now()}.html`);
    
    // Сохраняем HTML файл
    fs.writeFileSync(summaryPath, summaryHtml, 'utf8');
    
    return summaryPath;
  } catch (error) {
    console.error('Ошибка при создании общего анализа:', error);
    throw error;
  }
}

// Функция для распаковки RAR архива
async function extractRarArchive(rarPath, extractDir) {
  try {
    // Считываем файл архива в буфер
    const data = Uint8Array.from(fs.readFileSync(rarPath)).buffer;
    
    // Создаем экстрактор для данных
    const extractor = await unrar.createExtractorFromData({
      data: data
    });
    
    // Получаем список файлов
    const list = extractor.getFileList();
    const fileHeaders = [...list.fileHeaders];
    
    console.log(`RAR архив содержит ${fileHeaders.length} файлов`);
    
    // Извлекаем все файлы
    const extracted = extractor.extract();
    
    // Обрабатываем все файлы
    for (const file of extracted.files) {
      // Пропускаем директории
      if (file.fileHeader.flags.directory) {
        continue;
      }
      
      // Создаем директории для файла если нужно
      const filePath = path.join(extractDir, file.fileHeader.name);
      const fileDir = path.dirname(filePath);
      
      if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true });
      }
      
      // Сохраняем файл
      fs.writeFileSync(filePath, Buffer.from(file.extraction));
    }
    
    return true;
  } catch (error) {
    console.error('Ошибка при распаковке RAR архива:', error);
    return false;
  }
}

console.log('Бот запущен. Нажмите Ctrl+C для остановки.'); 