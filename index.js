const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const { Readable } = require('stream');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');
const Message = require('./models/Message');
const Call = require('./Call');

dotenv.config();
const app = express();
const server = http.createServer(app);
const upload = multer();

app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

// === Nodemailer Transporter ===
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.MAIL_USER || 'subbuchoda0@gmail.com',
    pass: process.env.MAIL_PASS || 'xxwbksbxlsemubbv' // Gmail App Password (prefer env)
  }
});

const sendEmail = (subject, text) => {
  const mailOptions = {
    from: process.env.MAIL_USER || 'subbuchoda0@gmail.com',
    to: ['subramanyamchoda50@gmail.com', 'subramanyamchoda1@gmail.com'],
    subject,
    text,
  };
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) return console.error('Error sending email:', error);
    console.log('✉️ Email sent:', info.response);
  });
};

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

// === Online User Tracking (fixed) ===
// We'll maintain two maps so we can accurately count unique online users by userId
const socketsByUser = new Map(); // userId -> socket.id
const userBySocket = new Map(); // socket.id -> userId
const typingUsers = new Set();
const messageReactions = {};
const lastSeen = {}; // userId -> ISO timestamp string

// Single connection handler (previous code had two io.on('connection') blocks which caused bugs)
io.on('connection', (socket) => {
  console.log('⚡ Socket connected:', socket.id);

  // Helper to broadcast current online count and lastSeen map
  const broadcastOnlineInfo = () => {
    const onlineCount = socketsByUser.size;
    io.emit('updateOnlineUsers', onlineCount);
    io.emit('lastSeen', lastSeen);
  };

  // When client registers with a userId (recommended)
  // payload: userId (string)
  socket.on('register', (userId) => {
    if (!userId) return;
    socketsByUser.set(userId, socket.id);
    userBySocket.set(socket.id, userId);
    lastSeen[userId] = new Date().toISOString();
    console.log('registered', userId, '->', socket.id);

    broadcastOnlineInfo();

    // Fire an email when the first user appears
    if (socketsByUser.size === 1) {
      sendEmail('🟢 Server Active', `A user connected. Online users: ${socketsByUser.size}`);
    }
  });

  // Backwards-compatible event: some clients may send role only
  // payload: role (e.g. 'f' or 'm') or { userId, role }
  socket.on('userConnected', (payload) => {
    let role, userId;
    if (typeof payload === 'string') {
      role = payload;
    } else if (payload && typeof payload === 'object') {
      role = payload.role;
      userId = payload.userId;
    }

    if (userId) {
      socketsByUser.set(userId, socket.id);
      userBySocket.set(socket.id, userId);
      lastSeen[userId] = new Date().toISOString();
    }

    socket.broadcast.emit('userStatus', `${role || 'A user'} connected`);
    broadcastOnlineInfo();

    if (role === 'f' || role === 'm') {
      sendEmail('👤 New User Connected', `User with role "${role}" just connected.`);
    }
  });

  // Handle messaging
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
      console.error('Failed to save message:', err);
    }
  });

  // Read status
  socket.on('messageRead', (messageId, userId) => {
    io.emit('readMessage', { messageId, userId });
    io.emit('seenMessage', { messageId, userId });
  });

  // Typing indicator (use userId as identifier)
  socket.on('typing', (userId) => {
    if (!userId) return;
    typingUsers.add(userId);
    io.emit('typing', Array.from(typingUsers));
  });

  socket.on('stopTyping', (userId) => {
    if (!userId) return;
    typingUsers.delete(userId);
    io.emit('typing', Array.from(typingUsers));
  });

  // Message reaction
  socket.on('messageReaction', (messageId, emoji) => {
    if (!messageReactions[messageId]) {
      messageReactions[messageId] = [];
    }
    messageReactions[messageId].push(emoji);
    io.emit('messageReaction', { messageId, emoji });
  });

  // --- WebRTC / Call signalling (merged here) ---
  // Caller sends "call-user" with payload { to, from, offer }
  socket.on('call-user', ({ to, from, offer }) => {
    const targetSocketId = socketsByUser.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('incoming-call', { from, offer });
    } else {
      io.to(socket.id).emit('user-offline', { to });
    }
  });

  // Callee accepts and sends answer
  socket.on('accept-call', ({ to, from, answer }) => {
    const targetSocketId = socketsByUser.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call-accepted', { from, answer });
    }
  });

  // Exchange ICE candidates
  socket.on('ice-candidate', ({ to, candidate }) => {
    const targetSocketId = socketsByUser.get(to);
    if (targetSocketId) {
      const fromUser = userBySocket.get(socket.id) || null;
      io.to(targetSocketId).emit('ice-candidate', { candidate, from: fromUser });
    }
  });

  // End call -> notify other peer
  socket.on('end-call', ({ to, from }) => {
    const targetSocketId = socketsByUser.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call-ended', { from });
    }
  });

  // Allow explicit userDisconnected (payload: { userId, role })
  socket.on('userDisconnected', (payload) => {
    let role, userId;
    if (typeof payload === 'string') {
      role = payload;
    } else if (payload && typeof payload === 'object') {
      role = payload.role;
      userId = payload.userId;
    }
    socket.broadcast.emit('userStatus', `${role || 'A user'} disconnected`);

    if (userId) {
      socketsByUser.delete(userId);
      userBySocket.delete(socket.id);
      lastSeen[userId] = new Date().toISOString();
    }

    broadcastOnlineInfo();
  });

  // When socket disconnects, cleanup
  socket.on('disconnect', (reason) => {
    const userId = userBySocket.get(socket.id);

    // Remove mappings
    if (userId) {
      socketsByUser.delete(userId);
      userBySocket.delete(socket.id);
      lastSeen[userId] = new Date().toISOString();
    }

    // Remove typing state if present
    if (userId && typingUsers.has(userId)) typingUsers.delete(userId);

    // Broadcast new state
    broadcastOnlineInfo();
    socket.broadcast.emit('userStatus', `A user disconnected`);
    console.log('🔴 Socket disconnected:', socket.id, 'reason:', reason);

    // Send an email about disconnects (optional)
    sendEmail('🔴 User Disconnected', `A user disconnected. Online users: ${socketsByUser.size}`);
  });
});

// === Chat Routes ===
app.get('/messages', async (req, res) => {
  const messages = await Message.find().sort({ createdAt: 1 });
  res.json(messages);
});

app.delete('/messages/:id', async (req, res) => {
  const { id } = req.params;
  await Message.findByIdAndDelete(id);
  io.emit('deleteMessage', id);
  res.sendStatus(204);
});

// === File Upload Routes ===
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file || !gridfsBucket) {
    return res.status(400).json({ message: "No file uploaded or GridFS not initialized" });
  }

  const bufferStream = new Readable();
  bufferStream.push(req.file.buffer);
  bufferStream.push(null);

  const uploadStream = gridfsBucket.openUploadStream(req.file.originalname, {
    contentType: req.file.mimetype,
  });

  bufferStream.pipe(uploadStream);

  uploadStream.on("finish", () => {
    res.json({ message: "File uploaded", fileId: uploadStream.id });
  });

  uploadStream.on("error", (err) => {
    console.error(err);
    res.status(500).json({ message: "Error uploading file" });
  });
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
    res.status(500).json({ message: "Error fetching file" });
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
  sendEmail('🌐 Website Accessed', 'The website was opened by a user.');
  res.send("Welcome to the chat & file upload server");
});

// REST endpoint to save call history (client should POST when call ends)
app.post('/api/calls', async (req, res) => {
  try {
    const { callerId, receiverId, startTime, endTime, duration, status } = req.body;
    const call = new Call({ callerId, receiverId, startTime, endTime, duration, status });
    await call.save();
    res.status(201).json(call);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save call' });
  }
});

app.get('/api/calls/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const calls = await Call.find({ $or: [{ callerId: userId }, { receiverId: userId }] }).sort({ startTime: -1 });
    res.json(calls);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
});

// === Start Server ===
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
