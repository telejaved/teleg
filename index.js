
const TelegramBot = require('node-telegram-bot-api');
const { google } = require("googleapis");
require('dotenv').config();

const TOKEN = process.env.TELEGRAM_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

const bot = new TelegramBot(TOKEN, { polling: true });

const userData = {};

function extractFileId(url) {
  const match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

async function createFolder(drive, name, parent = null) {
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parent ? [parent] : [],
    },
    fields: "id, name",
  });
  return res.data;
}

async function listFilesInFolder(drive, folderId) {
  const files = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageToken,
    });
    files.push(...res.data.files);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function countFilesAndFolders(drive, folderId) {
  const files = await listFilesInFolder(drive, folderId);
  let fileCount = 0, folderCount = 0;

  for (const file of files) {
    if (file.mimeType === "application/vnd.google-apps.folder") {
      folderCount++;
      const sub = await countFilesAndFolders(drive, file.id);
      fileCount += sub.fileCount;
      folderCount += sub.folderCount;
    } else {
      fileCount++;
    }
  }

  return { fileCount, folderCount };
}

async function copyFile(drive, fileId, destFolderId) {
  return await drive.files.copy({
    fileId,
    requestBody: { parents: [destFolderId] },
  });
}

async function copyFolderContents(drive, srcId, destId, progressCallback) {
  const files = await listFilesInFolder(drive, srcId);
  let processed = 0;

  for (const file of files) {
    if (file.mimeType === "application/vnd.google-apps.folder") {
      const newFolder = await createFolder(drive, file.name, destId);
      processed += await copyFolderContents(drive, file.id, newFolder.id, progressCallback);
    } else {
      await copyFile(drive, file.id, destId);
      processed++;
      progressCallback(processed);
    }
  }

  return processed;
}

bot.onText(/\/driveup/, async (msg) => {
  const chatId = msg.chat.id;
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/drive"],
    prompt: "consent",
  });

  userData[chatId] = { waitingForCode: true };

  bot.sendMessage(chatId, `🔐 DriveUp Setup\n\n1. Click: ${url}\n2. Allow access\n3. Copy the FULL redirected URL and send it here.`);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (userData[chatId]?.waitingForCode && text.includes("code=")) {
    const code = text.match(/code=([^&\s]+)/)?.[1];
    if (!code) return;

    const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    try {
      const { tokens } = await oAuth2Client.getToken(code);
      oAuth2Client.setCredentials({ refresh_token: tokens.refresh_token });
      const drive = google.drive({ version: "v3", auth: oAuth2Client });

      const folder = await createFolder(drive, "DriveUp Uploads");

      userData[chatId] = {
        refresh_token: tokens.refresh_token,
        folder_id: folder.id,
      };

      bot.sendMessage(chatId, `✅ Setup complete! Folder: https://drive.google.com/drive/folders/${folder.id}`);
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, "❌ Authorization failed.");
    }
  }

  if (text.includes("drive.google.com") && userData[chatId]?.refresh_token) {
    const srcId = extractFileId(text);
    if (!srcId) return bot.sendMessage(chatId, "❌ Invalid folder URL.");

    const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    oAuth2Client.setCredentials({ refresh_token: userData[chatId].refresh_token });
    const drive = google.drive({ version: "v3", auth: oAuth2Client });

    try {
      const { fileCount, folderCount } = await countFilesAndFolders(drive, srcId);
      const meta = await drive.files.get({ fileId: srcId, fields: "name" });

      const newFolder = await createFolder(drive, meta.data.name, userData[chatId].folder_id);
      bot.sendMessage(chatId, `📁 Copying ${meta.data.name}...`);

      const copied = await copyFolderContents(drive, srcId, newFolder.id, () => {});
      bot.sendMessage(chatId, `✅ Done! Copied ${copied} items.`);
    } catch (err) {
      console.error(err.message);
      bot.sendMessage(chatId, "❌ Copy failed.");
    }
  }
});
