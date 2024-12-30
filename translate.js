const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');
const grayMatter = require('gray-matter');
require('dotenv').config();

const articlesDir = path.join(__dirname, 'articles');
const targetLanguages = ['ru', 'uk', 'en', 'pl', 'de', 'es', 'fr']; // Target translation languages
const apiKey = process.env.DEEPL_API_KEY;

if (!apiKey) {
  console.error("ERROR: DeepL API key is missing. Set DEEPL_API_KEY in the environment.");
  process.exit(1);
}

const languageMapping = {
  ua: 'UK',
};

function getKeyByValue(object, value) {
  return Object.keys(object).find(key => object[key] === value) || value.toLowerCase();
}

/**
 * Get a list of modified files using git
 * @returns {string[]} - Array of paths to modified files
 */
function getChangedFiles() {
  try {
    const isGithubActions = process.env.GITHUB_SHA !== undefined;
    if (isGithubActions) {
      const output = execSync('git diff-tree --no-commit-id --name-only -r HEAD').toString();;
      return output.split('\n').filter(file => file.endsWith('.md'));
    } else {
      const output = execSync('git diff --cached --name-only').toString();
      return output.split('\n').filter(file => file.endsWith('.md'));
    }
  } catch (error) {
    console.error('Failed to get changed files from git:', error);
    return [];
  }
}

/**
 * Stage, commit, and push changes to the repository
 * @param {string[]} filePaths - Array of file paths to commit
 */
function commitAndPushChanges(filePaths) {
  try {
    if (filePaths.length === 0) {
      console.log('No files to commit.');
      return;
    }

    // Add files to git
    execSync(`git add ${filePaths.join(' ')}`);
    console.log('Files added to git:', filePaths);

    // Commit changes
    execSync('git commit -m "Add translated articles"');
    console.log('Commit created.');

    // Push changes
    execSync('git push');
    console.log('Changes pushed to the repository.');
  } catch (error) {
    console.error('Failed to commit and push changes:', error);
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
      params.source_lang = languageMapping?.[sourceLang.toLowerCase()] || sourceLang;
    }
    const response = await axios.post('https://api-free.deepl.com/v2/translate', null, { params });
    return response.data.translations[0].text;
  } catch (error) {
    console.error(`ERROR: Failed to translate text to ${targetLang}`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Translate metadata fields
 * @param {object} metadata - Metadata object to translate
 * @param {string[]} fieldsToTranslate - Fields that need to be translated
 * @param {string} targetLang - Target language for translation
 * @param {string|null} sourceLang - Source language for translation
 * @returns {object} - Translated metadata
 */
async function translateMetadata(metadata, fieldsToTranslate, targetLang, sourceLang) {
  const translatedMetadata = { ...metadata };

  for (const field of fieldsToTranslate) {
    if (metadata[field]) {
      try {
        translatedMetadata[field] = await translateText(metadata[field], targetLang, sourceLang);
      } catch (error) {
        console.error(`Failed to translate metadata field \"${field}\":`, error);
        translatedMetadata[field] = metadata[field]; // Fallback to original value
      }
    }
  }

  return translatedMetadata;
}

/**
 * Synchronize translations with the original order
 * @param {string} originalText - Original text
 * @param {string} translatedText - Existing translated text
 * @param {function} translateFn - Function to translate missing lines
 * @returns {Promise<string>} - Updated translated text
 */
async function synchronizeTranslations(originalText, translatedText, translateFn) {
  const originalLines = originalText.split('\n');
  const translatedLines = translatedText.split('\n').map(line => line.trim());
  const updatedLines = [];

  for (const line of originalLines) {
    if (line.trim() === '') {
      updatedLines.push(''); // Keep blank lines
      continue;
    }

    const index = translatedLines.indexOf(line.trim());
    if (index !== -1) {
      updatedLines.push(translatedLines[index]); // Use existing translation
    } else {
      const newTranslation = await translateFn(line.trim());
      updatedLines.push(newTranslation); // Translate missing line
    }
  }

  return updatedLines.join('\n');
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

  // Step 1: Set isOriginal for single files
  for (const filePath of changedFiles) {
    const articlePath = path.dirname(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const { content: articleText, data: metadata } = grayMatter(content);

    const allFilesInDirectory = fs.readdirSync(articlePath).filter(file => file.endsWith('.md'));
    if (allFilesInDirectory.length === 1 && !metadata.isOriginal) {
      metadata.isOriginal = true;
      const updatedContent = grayMatter.stringify(articleText, metadata);
      fs.writeFileSync(filePath, updatedContent);
      console.log(`Set isOriginal: true for ${filePath}`);
    }
  }

  // Step 2: Process original files and create translations
  for (const filePath of changedFiles) {
    const articlePath = path.dirname(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const { content: articleText, data: metadata } = grayMatter(content);

    if (!metadata.isOriginal) {
      console.log(`Skipping translation file: ${filePath}`);
      continue;
    }

    console.log(`Processing original file: ${filePath}`);

    const sourceLang = filePath.match(/_([a-z]{2})\.md$/i)?.[1]?.toUpperCase() || null;
    const newFiles = []; 
    
    for (const lang of targetLanguages) {
      if (sourceLang && lang.toUpperCase() === sourceLang.toUpperCase()) {
        console.log(`Skipping translation for ${lang}, as it matches the source language.`);
        continue;
      }

      const targetLangFile = getKeyByValue(languageMapping, lang.toUpperCase());
      const newFileName = path.basename(filePath).replace(/_[a-z]{2}\.md$/i, `_${targetLangFile}.md`);
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
        // Translate metadata fields
        const fieldsToTranslate = ['title', 'author'];
        const translatedMetadata = await translateMetadata(metadata, fieldsToTranslate, lang, sourceLang);

        // Synchronize translations with the original order
        const updatedText = await synchronizeTranslations(
          articleText,
          existingTranslatedText,
          async (line) => await translateText(line, lang, sourceLang)
        );

        const newContent = grayMatter.stringify(updatedText, { ...translatedMetadata, isOriginal: false });

        fs.writeFileSync(newFilePath, newContent);
        newFiles.push(newFilePath); // Track new files
        console.log(`Updated translation created: ${newFileName}`);
      } catch (error) {
        console.error(`Failed to process translation for ${filePath} to ${lang}.`, error);
      }
    }
    commitAndPushChanges(newFiles);
  }

  console.log('All files processed!');
}

// Run the script
processArticles().catch(error => {
  console.error('Unexpected error occurred:', error);
});
