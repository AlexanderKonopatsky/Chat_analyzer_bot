const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');

// Получаем путь к ZIP-файлу из аргументов командной строки или используем значение по умолчанию
const zipFilePath = process.argv[2] || './Санёк Санка.zip';

// Получаем имя архива без расширения для использования как имя папки
const zipFileName = path.basename(zipFilePath, path.extname(zipFilePath));
const extractPath = `./${zipFileName}`;

// Создаем папку если её нет
if (!fs.existsSync(extractPath)) {
  fs.mkdirSync(extractPath, { recursive: true });
}

try {
  console.log(`Распаковка ${zipFilePath}...`);
  const zip = new AdmZip(zipFilePath);
  zip.extractAllTo(extractPath, true);
  console.log(`Архив успешно распакован в ${extractPath}`);
} catch (err) {
  console.error('Ошибка при распаковке:', err);
} 