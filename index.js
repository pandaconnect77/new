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
    user: 'subbuchoda0@gmail.com',
    pass: 'xxwbksbxlsemubbv' // Gmail App Password
  }
});

const sendEmail = (subject, text) => {
  const mailOptions = {
    from: 'subbuchoda0@gmail.com',
    to:['subramanyamchoda50@gmail.com', 'subramanyamchoda1@gmail.com'],
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

// === Online User Tracking ===
let onlineUsers = 0;
let lastSeen = {};
let messageReactions = {};
let typingUsers = {};

io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('updateOnlineUsers', onlineUsers);
  console.log('🟢 A user connected. Total:', onlineUsers);

  // Send email when onlineUsers becomes 1
  if (onlineUsers === 1) {
    sendEmail('🟢 Server Active', `A user connected. Online users: ${onlineUsers}`);
  }

  // Assign role and track last seen
  socket.on('userConnected', (role) => {
    lastSeen[socket.id] = new Date().toLocaleTimeString();
    socket.broadcast.emit('userStatus', `${role} connected`);
    io.emit('lastSeen', lastSeen);

    if (role === 'f' || role === 'm') {
      sendEmail('👤 New User Connected', `User with role "${role}" just connected.`);
    }
  });

  // Handle messaging
  socket.on('sendMessage', async (msg) => {
    const message = new Message({
      text: msg.text,
      sender: msg.sender,
      image: msg.image || null,
    });
    const saved = await message.save();
    io.emit('message', saved);
  });

  // Read status
  socket.on('messageRead', (messageId, userId) => {
    io.emit('readMessage', { messageId, userId });
    io.emit('seenMessage', { messageId, userId });
  });

  // Typing indicator
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

  // Message reaction
  socket.on('messageReaction', (messageId, emoji) => {
    if (!messageReactions[messageId]) {
      messageReactions[messageId] = [];
    }
    messageReactions[messageId].push(emoji);
    io.emit('messageReaction', { messageId, emoji });
  });

  // Disconnect
  socket.on('userDisconnected', (role) => {
    socket.broadcast.emit('userStatus', `${role} disconnected`);
  });

  socket.on('disconnect', () => {
    onlineUsers--;
    io.emit('updateOnlineUsers', onlineUsers);
    socket.broadcast.emit('userStatus', `A user disconnected`);
    console.log('🔴 A user disconnected. Total:', onlineUsers);

    lastSeen[socket.id] = new Date().toLocaleTimeString();
    io.emit('lastSeen', lastSeen);

    sendEmail('🔴 User Disconnected', `A user disconnected. Online users: ${onlineUsers}`);
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


  const onlineUsers1 = new Map();
    
    io.on('connection', (socket) => {
      console.log('socket connected', socket.id);
    
      socket.on('register', (userId) => {
        onlineUsers1.set(userId, socket.id);
        socket.userId = userId;
        console.log('registered', userId, '->', socket.id);
      });
    
      // Caller sends "call-user" with payload { to, from, offer }
      socket.on('call-user', ({ to, from, offer }) => {
        const targetSocket = onlineUsers1.get(to);
        if (targetSocket) {
          io.to(targetSocket).emit('incoming-call', { from, offer });
        } else {
          // optionally notify caller that user is offline
          io.to(socket.id).emit('user-offline', { to });
        }
      });
    
      // Callee accepts and sends answer
      socket.on('accept-call', ({ to, from, answer }) => {
        const targetSocket = onlineUsers1.get(to); // caller's socket
        if (targetSocket) {
          io.to(targetSocket).emit('call-accepted', { from, answer });
        }
      });
    
      // Exchange ICE candidates
      socket.on('ice-candidate', ({ to, candidate }) => {
        const targetSocket = onlineUsers1.get(to);
        if (targetSocket) {
          io.to(targetSocket).emit('ice-candidate', { candidate, from: socket.userId });
        }
      });
    
      // End call -> notify other peer
      socket.on('end-call', ({ to, from }) => {
        const targetSocket = onlineUsers1.get(to);
        if (targetSocket) {
          io.to(targetSocket).emit('call-ended', { from });
        }
      });
    
      socket.on('disconnect', () => {
        if (socket.userId) {
          onlineUsers1.delete(socket.userId);
          console.log('user disconnected', socket.userId);
        }
      });
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


