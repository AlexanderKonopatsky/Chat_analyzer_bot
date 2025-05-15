const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Конфигурация
const INPUT_ARCHIVE = 'Санёк Санка.zip';
const OUTPUT_TEXT_FILE = 'Санёк_Санка.txt';

console.log('=== Начало полной обработки ===');

// Шаг 1: Распаковка архива
console.log('\n>> Распаковка архива...');
execSync(`node extract.js "${INPUT_ARCHIVE}"`, { stdio: 'inherit' });

// Получаем имя извлеченной папки
const extractedFolderName = path.basename(INPUT_ARCHIVE, path.extname(INPUT_ARCHIVE));
console.log(`Архив распакован в папку: ${extractedFolderName}`);

// Шаг 2: Конвертация HTML в JSON
console.log('\n>> Конвертация сообщений HTML в JSON...');
// Создаем временную копию convert-messages.js с нужными путями
const convertMessagesSource = fs.readFileSync('convert-messages.js', 'utf8');
const modifiedConverter = convertMessagesSource
  .replace(/const sourceDir = '.\/messages';/, `const sourceDir = './${extractedFolderName}';`)
  .replace(/const outputDir = '.\/converted';/, `const outputDir = './${extractedFolderName}_converted';`);

fs.writeFileSync('temp-convert-messages.js', modifiedConverter);
execSync('node temp-convert-messages.js', { stdio: 'inherit' });
fs.unlinkSync('temp-convert-messages.js');

// Шаг 3: Объединение JSON-файлов
console.log('\n>> Объединение JSON-файлов в правильном порядке...');
// Создаем временную копию merge-correct-order.js с нужными путями
const mergeSource = fs.readFileSync('merge-correct-order.js', 'utf8');
const modifiedMerge = mergeSource
  .replace(/const jsonDir = '.\/converted';/, `const jsonDir = './${extractedFolderName}_converted';`)
  .replace(/const outputFile = '.\/all-messages-sorted.json';/, `const outputFile = './${extractedFolderName}_all-messages-sorted.json';`);

fs.writeFileSync('temp-merge-correct-order.js', modifiedMerge);
execSync('node temp-merge-correct-order.js', { stdio: 'inherit' });
fs.unlinkSync('temp-merge-correct-order.js');

// Шаг 4: Конвертация в текстовый формат
console.log('\n>> Создание финального текстового файла...');
// Создаем временную копию converter.js с нужными путями
const converterSource = fs.readFileSync('converter.js', 'utf8');
const modifiedFinalConverter = converterSource
  .replace(/const inputFilePath = 'all-messages-sorted.json';/, `const inputFilePath = '${extractedFolderName}_all-messages-sorted.json';`)
  .replace(/const outputFilePath = 'messages.txt';/, `const outputFilePath = '${OUTPUT_TEXT_FILE}';`);

fs.writeFileSync('temp-converter.js', modifiedFinalConverter);
execSync('node temp-converter.js', { stdio: 'inherit' });
fs.unlinkSync('temp-converter.js');

console.log('\n=== Обработка завершена ===');
console.log(`Финальный текстовый файл создан: ${OUTPUT_TEXT_FILE}`);
console.log('Вы можете удалить временные файлы и папки, если они больше не нужны.'); 