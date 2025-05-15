const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

// Функция для извлечения сообщений из HTML-файла
const extractMessages = (filePath) => {
  try {
    // Чтение файла с учетом кодировки windows-1251
    const buffer = fs.readFileSync(filePath);
    const html = iconv.decode(buffer, 'windows-1251');
    
    const $ = cheerio.load(html);
    const messages = [];
    
    // Извлечение данных из каждого блока сообщения
    $('.item').each((_, element) => {
      const messageBlock = $(element).find('.message');
      if (!messageBlock.length) return;
      
      const messageId = messageBlock.attr('data-id');
      const header = messageBlock.find('.message__header').text().trim();
      
      // Извлечение автора и даты
      let sender = 'Unknown';
      let date = '';
      
      // Если в заголовке есть ссылка, значит отправитель - другой пользователь
      const senderLink = messageBlock.find('.message__header a');
      if (senderLink.length) {
        sender = senderLink.text().trim();
        
        // Извлекаем дату (после запятой и пробела)
        const headerText = header.split(', ');
        if (headerText.length > 1) {
          date = headerText.slice(1).join(', ');
        }
      } else {
        // Если нет ссылки, сообщение от текущего пользователя
        sender = 'Вы';
        date = header;
      }
      
      // Извлечение текста сообщения - ИСПРАВЛЕНО
      let text = '';
      
      // Получаем контейнер с содержимым сообщения (второй div после заголовка)
      const contentContainer = messageBlock.find('.message__header').next('div');
      
      if (contentContainer.length) {
        // Клонируем контейнер и удаляем из него блок kludges с вложениями
        const cleanContent = contentContainer.clone();
        cleanContent.find('.kludges').remove();
        
        // Получаем текст без вложений
        text = cleanContent.text().trim();
      }
      
      // Извлечение вложений
      const attachments = [];
      messageBlock.find('.attachment').each((_, attachmentElement) => {
        const attachmentElem = $(attachmentElement);
        const type = attachmentElem.find('.attachment__description').text().trim();
        let link = attachmentElem.find('.attachment__link').attr('href') || '';
        
        // Проверяем, является ли вложение ответом на сообщение
        if (type.includes('прикреплённое сообщение') || type.includes('пересланное сообщение')) {
          // Для прикреплённых сообщений нужно найти оригинальное сообщение
          // Поиск в соседних элементах или родительском контексте
          
          // Сначала проверим, есть ли ссылка на сообщение в родительском блоке
          const parentMessage = attachmentElem.closest('.message');
          if (parentMessage.length) {
            // Ищем сообщение, на которое отвечают, путем поиска соседних сообщений
            const messagesContext = $('.item');
            let replyToMessage = null;
            
            // Проходим по всем сообщениям и ищем то, на которое мог быть ответ
            // В VK обычно отвечают на предыдущие сообщения
            messagesContext.each((idx, msgElement) => {
              const msgBlock = $(msgElement).find('.message');
              const msgId = msgBlock.attr('data-id');
              
              // Если это не текущее сообщение и оно находится перед текущим
              if (msgId && msgId !== messageId) {
                // Сохраняем информацию о возможном сообщении
                const msgHeader = msgBlock.find('.message__header').text().trim();
                
                // Получаем текст сообщения
                const msgContentContainer = msgBlock.find('.message__header').next('div');
                let msgText = '';
                
                if (msgContentContainer.length) {
                  const cleanContent = msgContentContainer.clone();
                  cleanContent.find('.kludges').remove();
                  msgText = cleanContent.text().trim();
                }
                
                // Если это сообщение находится перед текущим, вероятно, на него и отвечают
                if (idx < messagesContext.index(parentMessage.closest('.item'))) {
                  replyToMessage = {
                    id: msgId,
                    header: msgHeader,
                    text: msgText
                  };
                }
              }
            });
            
            if (replyToMessage) {
              // Добавляем информацию о найденном сообщении
              attachments.push({
                type,
                reply_to_id: replyToMessage.id,
                reply_to_text: replyToMessage.text,
                reply_to_header: replyToMessage.header
              });
            } else {
              // Если не удалось найти сообщение, просто добавляем тип
              attachments.push({ type });
            }
          } else {
            // Если не удалось найти родительский блок, просто добавляем тип
            attachments.push({ type });
          }
        } else {
          // Обычные вложения
          attachments.push({ type, link });
        }
      });
      
      messages.push({
        id: messageId,
        sender,
        date,
        text,
        attachments: attachments.length ? attachments : undefined
      });
    });
    
    return messages;
  } catch (err) {
    console.error(`Ошибка при обработке файла ${filePath}: ${err.message}`);
    return [];
  }
};

// Обработка одиночного файла
const processSingleFile = (inputFile, outputFile) => {
  if (!fs.existsSync(inputFile)) {
    console.error(`Файл не найден: ${inputFile}`);
    return;
  }
  
  console.log(`Обработка файла: ${inputFile}`);
  const messages = extractMessages(inputFile);
  
  if (messages.length === 0) {
    console.log('Сообщения не найдены');
    return;
  }
  
  // Определение выходного файла
  const outputPath = outputFile || `${path.basename(inputFile, '.html')}.json`;
  
  // Сохраняем результат в JSON-файл
  fs.writeFileSync(outputPath, JSON.stringify(messages, null, 2), 'utf8');
  
  console.log(`Обработка завершена: извлечено ${messages.length} сообщений`);
  console.log(`Результат сохранен в: ${outputPath}`);
};

// Экспорт функции для использования в других модулях
module.exports = {
  extractMessages,
  processSingleFile
};

// Получение аргументов командной строки
const args = process.argv.slice(2);

if (args.length < 1) {
  console.log('Использование: node single-file-converter.js <путь_к_html_файлу> [путь_к_выходному_json]');
} else {
  processSingleFile(args[0], args[1]);
} 