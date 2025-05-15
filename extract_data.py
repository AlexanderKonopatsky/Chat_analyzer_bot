import os
import re
from bs4 import BeautifulSoup
from pathlib import Path

# Путь к папке с HTML файлами
input_dir = "result"
# Путь для сохранения текстовых файлов
output_dir = "extracted_text"

# Создаем папку для текстовых файлов, если её нет
os.makedirs(output_dir, exist_ok=True)

# Получаем список всех HTML файлов в папке
html_files = [f for f in os.listdir(input_dir) if f.endswith('.html')]

for html_file in html_files:
    # Полный путь к текущему файлу
    file_path = os.path.join(input_dir, html_file)
    
    # Имя файла без расширения для создания текстового файла
    base_name = os.path.splitext(html_file)[0]
    output_file = os.path.join(output_dir, f"{base_name}.txt")
    
    # Читаем HTML файл
    with open(file_path, 'r', encoding='utf-8') as f:
        html_content = f.read()
    
    # Парсим HTML
    soup = BeautifulSoup(html_content, 'html.parser')
    
    # Извлекаем метаданные
    metadata_items = soup.select('.metadata-item')
    metadata_text = ""
    
    for item in metadata_items:
        label = item.select_one('.metadata-label')
        value = item.text.replace(label.text, '') if label else item.text
        metadata_text += f"{label.text.strip() if label else ''} {value.strip()}\n"
    
    # Получаем дату анализа
    timestamp = soup.select_one('.timestamp')
    timestamp_text = timestamp.text.strip() if timestamp else ""
    
    # Извлекаем ответ модели
    response = soup.select_one('.response pre')
    response_text = response.text if response else ""
    
    # Формируем финальный текст
    final_text = f"{metadata_text}\n{timestamp_text}\n\n{'='*50}\n\nОТВЕТ МОДЕЛИ:\n\n{response_text}"
    
    # Сохраняем результат в текстовый файл
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(final_text)
    
    print(f"Обработан файл: {html_file} -> {base_name}.txt")

print(f"\nГотово! Извлеченные данные сохранены в папку: {output_dir}") 