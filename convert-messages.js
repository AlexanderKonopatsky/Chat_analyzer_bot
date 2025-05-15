const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { extractMessages } = require('./single-file-converter');

// Папка с HTML-файлами
const sourceDir = './messages';
// Папка для сохранения JSON-файлов
const outputDir = './converted';

// Создаем папку для вывода, если она не существует
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Получаем список всех HTML-файлов в директории
const getHtmlFiles = (dir) => {
  try {
    const pattern = path.join(dir, '*.html').replace(/\\/g, '/');
    return glob.sync(pattern);
  } catch (err) {
    console.error(`Ошибка при чтении директории: ${err.message}`);
    return [];
  }
};

// Функция для обработки отдельного файла
const processFile = (file) => {
  try {
    // Получаем сообщения из HTML-файла
    const messages = extractMessages(file);
    
    // Формируем имя выходного файла
    const outputFile = path.join(outputDir, path.basename(file, '.html') + '.json');
    
    // Сохраняем результат в JSON-файл
    fs.writeFileSync(outputFile, JSON.stringify(messages, null, 2), 'utf8');
    
    console.log(`Обработан файл: ${file} (извлечено ${messages.length} сообщений)`);
    return messages.length;
  } catch (err) {
    console.error(`Ошибка при обработке файла ${file}: ${err.message}`);
    return 0;
  }
};

// Главная функция для обработки всех файлов
const processAllFiles = () => {
  const htmlFiles = getHtmlFiles(sourceDir);
  
  console.log(`Найдено ${htmlFiles.length} HTML-файлов для обработки`);
  
  let totalMessages = 0;
  let processedFiles = 0;
  
  // Обрабатываем каждый файл
  htmlFiles.forEach(filePath => {
    const messages = processFile(filePath);
    totalMessages += messages;
    processedFiles++;
  });
  
  console.log(`\nОбработка завершена:`);
  console.log(`- Обработано файлов: ${processedFiles} из ${htmlFiles.length}`);
  console.log(`- Извлечено сообщений: ${totalMessages}`);
  console.log(`- Результаты сохранены в директории: ${outputDir}`);
};

// Запуск обработки
processAllFiles(); 