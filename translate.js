const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');
const grayMatter = require('gray-matter');
require('dotenv').config();

const articlesDir = path.join(__dirname, 'articles');
const targetLanguages = ['ru', 'uk', 'en']; // Target translation languages
const apiKey = process.env.DEEPL_API_KEY;

if (!apiKey) {
  console.error("ERROR: DeepL API key is missing. Set DEEPL_API_KEY in the environment.");
  process.exit(1);
}

/**
 * Get a list of modified files using git
 * @returns {string[]} - Array of paths to modified files
 */
function getChangedFiles() {
  try {
    const output = execSync('git diff --name-only HEAD articles/').toString();
    return output.split('\n').filter(file => file.endsWith('.md'));
  } catch (error) {
    console.error('Failed to get changed files from git:', error);
    return [];
  }
}

/**
 * Translate text using DeepL API
 * @param {string} text - Text to be translated
 * @param {string} targetLang - Target translation language
 * @param {string|null} sourceLang - Source language (if known)
 * @returns {Promise<string>} - Translated text
 */
async function translateText(text, targetLang, sourceLang = null) {
  try {
    const params = {
      auth_key: apiKey,
      text,
      target_lang: targetLang,
    };

    if (sourceLang) {
      params.source_lang = sourceLang;
    }

    const response = await axios.post('https://api.deepl.com/v2/translate', null, { params });
    return response.data.translations[0].text;
  } catch (error) {
    console.error(`ERROR: Failed to translate text to ${targetLang}`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Update an existing translation
 * @param {string} originalText - Original text
 * @param {string} translatedText - Existing translated text
 * @param {string} newText - New text to be translated
 * @returns {string} - Updated translation
 */
function updateTranslation(originalText, translatedText, newText) {
  return `${translatedText}\n\n${newText}`;
}

/**
 * Process articles
 */
async function processArticles() {
  const changedFiles = getChangedFiles();

  if (changedFiles.length === 0) {
    console.log('No new or changed files detected.');
    return;
  }

  for (const filePath of changedFiles) {
    const articlePath = path.dirname(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const { content: articleText, data: metadata } = grayMatter(content);

    const sourceLang = filePath.match(/_([a-z]{2})\.md$/i)?.[1]?.toUpperCase() || null;

    console.log(`Processing file: ${filePath} (Source Language: ${sourceLang || 'Auto-detect'})`);

    for (const lang of targetLanguages) {
      if (sourceLang && lang.toUpperCase() === sourceLang) {
        console.log(`Skipping translation for ${lang}, as it matches the source language.`);
        continue;
      }

      const newFileName = path.basename(filePath).replace(/_[a-z]{2}\.md$/i, `_${lang}.md`);
      const newFilePath = path.join(articlePath, newFileName);

      let existingTranslatedText = '';
      if (fs.existsSync(newFilePath)) {
        const existingContent = fs.readFileSync(newFilePath, 'utf-8');
        existingTranslatedText = grayMatter(existingContent).content;
      }

      const untranslatedText = articleText.replace(existingTranslatedText, '').trim();
      if (!untranslatedText) {
        console.log(`No new text to translate for ${lang}.`);
        continue;
      }

      try {
        const translatedText = await translateText(untranslatedText, lang, sourceLang);
        const updatedText = updateTranslation(articleText, existingTranslatedText, translatedText);
        const newContent = grayMatter.stringify(updatedText, metadata);

        fs.writeFileSync(newFilePath, newContent);
        console.log(`Updated translation created: ${newFileName}`);
      } catch (error) {
        console.error(`Failed to process translation for ${filePath} to ${lang}.`, error);
      }
    }
  }

  console.log('All files processed!');
}

// Run the script
processArticles().catch(error => {
  console.error('Unexpected error occurred:', error);
});
