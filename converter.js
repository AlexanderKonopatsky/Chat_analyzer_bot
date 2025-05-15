const fs = require('fs');

// Путь к исходному JSON файлу и новому TXT файлу
const inputFilePath = 'all-messages-sorted.json';
const outputFilePath = 'messages.txt';

// Чтение и парсинг JSON файла
fs.readFile(inputFilePath, 'utf8', (err, data) => {
  if (err) {
    console.error('Ошибка при чтении файла:', err);
    return;
  }

  try {
    // Парсинг JSON
    const messages = JSON.parse(data);
    
    // Отладочная информация
    console.log(`Всего сообщений: ${messages.length}`);
    
    // Проверка сортировки сообщений
    messages.sort((a, b) => {
      // Сортировка по ID сообщений (предполагается, что они увеличиваются хронологически)
      return parseInt(a.id) - parseInt(b.id);
    });
    
    // Переменная для хранения предыдущей даты
    let previousDate = '';
    
    // Массив для хранения отформатированных сообщений
    const formattedMessagesArray = [];
    
    // Счетчики для отладки
    let emptySeparatorsAdded = 0;
    let messagesWithoutText = 0;
    
    // Обработка каждого сообщения
    messages.forEach(message => {
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
        formattedMessagesArray.push(`- ${currentDate} -`);
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
    
    // Запись результата в TXT файл
    fs.writeFile(outputFilePath, formattedMessages, 'utf8', (err) => {
      if (err) {
        console.error('Ошибка при записи файла:', err);
        return;
      }
      console.log(`Файл успешно создан: ${outputFilePath}`);
    });
  } catch (parseErr) {
    console.error('Ошибка при парсинге JSON:', parseErr);
  }
}); 