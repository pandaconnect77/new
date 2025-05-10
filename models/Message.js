const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  text: String,
  sender: String,
  image: String, // Add image field for storing Base64 string
  createdAt: {
    type: Date,
    default: () => Date.now() // This ensures the time is set when a new message is created
  }
});

module.exports = mongoose.model('Message', MessageSchema);
