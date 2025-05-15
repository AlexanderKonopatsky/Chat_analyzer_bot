const fs = require('fs');
const path = require('path');

// Папка с JSON-файлами
const jsonDir = './converted';
// Выходной файл
const outputFile = './all-messages-sorted.json';

// Получаем список всех JSON-файлов в директории
const getJsonFiles = (dir) => {
  try {
    return fs.readdirSync(dir)
      .filter(file => file.endsWith('.json'))
      .map(file => path.join(dir, file));
  } catch (err) {
    console.error(`Ошибка при чтении директории: ${err.message}`);
    return [];
  }
};

// Получаем номер файла из имени
const getFileNumber = (filePath) => {
  const fileName = path.basename(filePath);
  // Исправленное регулярное выражение для извлечения номера из формата messagesXXXXX.json
  const match = fileName.match(/messages(\d+)\.json/);
  return match ? parseInt(match[1]) : 0;
};

// Объединение JSON-файлов, сохраняя порядок сообщений
const mergeJsonFiles = () => {
  let jsonFiles = getJsonFiles(jsonDir);
  
  if (jsonFiles.length === 0) {
    console.error('JSON-файлы не найдены в директории');
    return;
  }
  
  console.log(`Найдено ${jsonFiles.length} JSON-файлов для объединения`);
  
  // Сортируем файлы по номеру (предполагается, что файлы названы с числовым префиксом)
  jsonFiles.sort((a, b) => {
    const numA = getFileNumber(a);
    const numB = getFileNumber(b);
    
    // Если оба файла без номера, сортируем по времени модификации
    if (numA === 0 && numB === 0) {
      return fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime(); // от новых к старым
    }
    
    return numB - numA; // от больших номеров к меньшим (от новых к старым)
  });
  
  // Выводим первые 5 файлов для проверки сортировки
  console.log('Первые 5 файлов после сортировки:');
  for (let i = 0; i < Math.min(5, jsonFiles.length); i++) {
    console.log(`${i + 1}. ${path.basename(jsonFiles[i])} (номер: ${getFileNumber(jsonFiles[i])})`);
  }
  
  // Объединяем сообщения из всех файлов
  let allMessages = [];
  let totalMessages = 0;
  
  // Читаем и обрабатываем каждый файл
  jsonFiles.forEach(filePath => {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const messages = JSON.parse(fileContent);
      
      if (Array.isArray(messages)) {
        // Просто добавляем сообщения в порядке, в котором они уже есть
        allMessages = allMessages.concat(messages);
        totalMessages += messages.length;
        console.log(`Добавлено ${messages.length} сообщений из ${path.basename(filePath)}`);
      }
    } catch (err) {
      console.error(`Ошибка при обработке файла ${filePath}: ${err.message}`);
    }
  });
  
  // Сохраняем результаты в один файл
  fs.writeFileSync(outputFile, JSON.stringify(allMessages, null, 2), 'utf8');
  
  // Создаем компактную версию без отступов для экономии места
  const compactFile = outputFile.replace('.json', '.min.json');
  fs.writeFileSync(compactFile, JSON.stringify(allMessages), 'utf8');
  
  console.log(`\nОбъединение завершено:`);
  console.log(`- Обработано файлов: ${jsonFiles.length}`);
  console.log(`- Общее количество сообщений: ${totalMessages}`);
  console.log(`- Результат сохранен в: ${outputFile}`);
  console.log(`- Компактная версия сохранена в: ${compactFile}`);
};

// Запускаем объединение
mergeJsonFiles(); 