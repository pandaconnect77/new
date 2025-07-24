// server/index.js

const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const { Readable } = require('stream');
const { Server } = require('socket.io');
const Message = require('./models/Message');

dotenv.config();
const app = express();
const upload = multer();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// === MongoDB + GridFS Setup ===
let gridfsBucket;
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
const connection = mongoose.connection;
connection.once('open', () => {
  console.log('✅ MongoDB connected');
  gridfsBucket = new mongoose.mongo.GridFSBucket(connection.db, {
    bucketName: 'uploads',
  });
});

// === Socket.IO Events ===
let onlineUsers = 0;
let lastSeen = {};
let messageReactions = {};
let typingUsers = {};

io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('updateOnlineUsers', onlineUsers);
  console.log('🔗 New client connected:', socket.id);

  // === VIDEO CALL EVENTS ===
  socket.emit('your-id', socket.id);

  socket.on('call-user', ({ to, signal, from, name }) => {
    io.to(to).emit('receive-call', { signal, from, name });
  });

  socket.on('answer-call', ({ to, signal }) => {
    io.to(to).emit('call-accepted', signal);
  });

  // === CHAT EVENTS ===
  socket.on('userConnected', (role) => {
    lastSeen[socket.id] = new Date().toLocaleTimeString();
    socket.broadcast.emit('userStatus', `${role} connected`);
    io.emit('lastSeen', lastSeen);
  });

  socket.on('sendMessage', async (msg) => {
    try {
      const message = new Message({
        text: msg.text,
        sender: msg.sender,
        image: msg.image || null,
      });
      const saved = await message.save();
      io.emit('message', saved);
    } catch (err) {
      console.error('Error saving message:', err);
    }
  });

  socket.on('messageRead', (messageId, userId) => {
    io.emit('readMessage', { messageId, userId });
    io.emit('seenMessage', { messageId, userId });
  });

  socket.on('typing', (userId) => {
    typingUsers[userId] = true;
    io.emit('typing', Object.keys(typingUsers).length > 0);
  });

  socket.on('stopTyping', (userId) => {
    delete typingUsers[userId];
    if (Object.keys(typingUsers).length === 0) {
      io.emit('stopTyping');
    }
  });

  socket.on('messageReaction', (messageId, emoji) => {
    if (!messageReactions[messageId]) {
      messageReactions[messageId] = [];
    }
    messageReactions[messageId].push(emoji);
    io.emit('messageReaction', { messageId, emoji });
  });

  socket.on('userDisconnected', (role) => {
    socket.broadcast.emit('userStatus', `${role} disconnected`);
  });

  socket.on('disconnect', () => {
    onlineUsers--;
    io.emit('updateOnlineUsers', onlineUsers);
    socket.broadcast.emit('userStatus', `A user disconnected`);
    lastSeen[socket.id] = new Date().toLocaleTimeString();
    io.emit('lastSeen', lastSeen);
    console.log('🔴 A user disconnected:', socket.id);
  });
});

// === Chat Routes ===
app.get('/messages', async (req, res) => {
  try {
    const messages = await Message.find().sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) {
    console.error('Failed to get messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.delete('/messages/:id', async (req, res) => {
  try {
    await Message.findByIdAndDelete(req.params.id);
    io.emit('deleteMessage', req.params.id);
    res.sendStatus(204);
  } catch (err) {
    console.error('Failed to delete message:', err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// === File Upload Routes ===
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file || !gridfsBucket) {
    return res.status(400).json({ message: "No file uploaded or GridFS not initialized" });
  }

  try {
    const readableFileStream = Readable.from(req.file.buffer);
    const uploadStream = gridfsBucket.openUploadStream(req.file.originalname, {
      contentType: req.file.mimetype,
    });

    readableFileStream.pipe(uploadStream)
      .on('error', (err) => {
        console.error('Upload error:', err);
        res.status(500).json({ message: 'Error uploading file' });
      })
      .on('finish', () => {
        res.status(200).json({ message: 'File uploaded', fileId: uploadStream.id });
      });
  } catch (error) {
    console.error('Unexpected error:', error);
    res.status(500).json({ message: 'Unexpected upload error' });
  }
});

app.get('/files', async (req, res) => {
  try {
    const files = await gridfsBucket.find().toArray();
    res.json(files);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error fetching files" });
  }
});

app.get('/files/:filename', async (req, res) => {
  try {
    const files = await gridfsBucket.find({ filename: req.params.filename }).toArray();
    if (!files.length) return res.status(404).json({ message: "File not found" });

    const file = files[0];
    res.set({
      "Content-Type": file.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
    });

    const downloadStream = gridfsBucket.openDownloadStream(file._id);
    downloadStream.pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error downloading file" });
  }
});

app.delete('/files/:filename', async (req, res) => {
  try {
    const files = await gridfsBucket.find({ filename: req.params.filename }).toArray();
    if (!files.length) return res.status(404).json({ message: "File not found" });

    await gridfsBucket.delete(files[0]._id);
    res.json({ message: "File deleted" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error deleting file" });
  }
});

// === Default Route ===
app.get('/', (req, res) => {
  res.send("Welcome to the Chat + File Upload + Video Call Server");
});

// === Start Server ===
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
