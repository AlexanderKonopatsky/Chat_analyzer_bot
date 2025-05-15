const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// Пути к директориям
const inputDir = 'result';
const outputDir = 'extracted_text';

// Создаем выходную директорию, если не существует
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

// Получаем список HTML файлов
const htmlFiles = fs.readdirSync(inputDir).filter(file => file.endsWith('.html'));

// Обрабатываем каждый файл
htmlFiles.forEach(htmlFile => {
  const filePath = path.join(inputDir, htmlFile);
  const baseName = path.basename(htmlFile, '.html');
  const outputFile = path.join(outputDir, `${baseName}.txt`);

  // Читаем HTML файл
  const htmlContent = fs.readFileSync(filePath, 'utf-8');
  
  // Парсим HTML с помощью cheerio
  const $ = cheerio.load(htmlContent);
  
  // Извлекаем метаданные
  let metadataText = '';
  $('.metadata-item').each((i, elem) => {
    const label = $(elem).find('.metadata-label').text().trim();
    const fullText = $(elem).text().trim();
    const value = fullText.replace(label, '').trim();
    metadataText += `${label} ${value}\n`;
  });
  
  // Получаем дату анализа
  const timestampText = $('.timestamp').text().trim() || '';
  
  // Извлекаем ответ модели
  const responseText = $('.response pre').text() || '';
  
  // Формируем финальный текст
  const finalText = `${metadataText}\n${timestampText}\n\n${'='.repeat(50)}\n\nОТВЕТ МОДЕЛИ:\n\n${responseText}`;
  
  // Сохраняем результат в текстовый файл
  fs.writeFileSync(outputFile, finalText, 'utf-8');
  
  console.log(`Обработан файл: ${htmlFile} -> ${baseName}.txt`);
});

console.log(`\nГотово! Извлеченные данные сохранены в папку: ${outputDir}`); 