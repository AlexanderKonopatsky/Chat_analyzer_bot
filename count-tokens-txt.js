const fs = require('fs');
const { execSync } = require('child_process');

// Проверяем наличие необходимого пакета для токенизации
try {
  require.resolve('gpt-tokenizer');
} catch (e) {
  console.log('Устанавливаем пакет gpt-tokenizer...');
  execSync('npm install gpt-tokenizer');
}

const { encode } = require('gpt-tokenizer');

// Путь к файлу сообщений
const messagesTxtPath = 'part2.txt';

// Функция для подсчета слов в тексте
function countWords(text) {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

// Функция для подсчета символов в тексте
function countChars(text) {
  return text.length;
}

// Функция для подсчета токенов GPT-4
function countGPT4Tokens(text) {
  const tokens = encode(text, { model: 'gpt-4' });
  return tokens.length;
}

// Чтение файла с сообщениями
fs.readFile(messagesTxtPath, 'utf8', (err, data) => {
  if (err) {
    console.error('Ошибка при чтении файла:', err);
    return;
  }

  // Подсчет слов, символов и токенов
  const wordsCount = countWords(data);
  const charsCount = countChars(data);
  const gpt4TokensCount = countGPT4Tokens(data);
  
  // Вывод результатов
  console.log('===== Подсчет токенов =====');
  console.log(`Количество слов: ${wordsCount}`);
  console.log(`Количество символов: ${charsCount}`);
  console.log(`Точное количество токенов GPT-4: ${gpt4TokensCount}`);
  console.log(`Соотношение токенов/слов: ${(gpt4TokensCount / wordsCount).toFixed(2)}`);
  
  // Вычисление количества сообщений
  const messageCount = data.split('\n').filter(line => line.trim() !== '').length;
  console.log(`Количество сообщений: ${messageCount}`);
  console.log(`Слов на сообщение: ${(wordsCount / messageCount).toFixed(2)}`);
  console.log(`Токенов на сообщение: ${(gpt4TokensCount / messageCount).toFixed(2)}`);
  

}); 