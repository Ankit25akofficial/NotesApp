require('dotenv').config({ path: __dirname + '/.env' });

const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const flash = require('connect-flash');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { formatDate, formatTime } = require('./utils/dateUtils');

const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const port = process.env.PORT || 3000;

app.locals.formatDate = formatDate;
app.locals.formatTime = formatTime;

const Note = require('./models/notes');
const User = require('./models/user');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.set('view engine', 'ejs');
app.use('/uploads', express.static('uploads'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'secret_key',
  resave: false,
  saveUninitialized: false
}));

app.use(flash());

app.use((req, res, next) => {
  res.locals.messages = req.flash();
  const token = req.cookies.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'jwt_secret');
      res.locals.user = decoded;
    } catch (err) {
      res.locals.user = null;
    }
  } else {
    res.locals.user = null;
  }
  next();
});

console.log("ENV VALUE:", process.env.MONGO_URL);

mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.log("MongoDB Error:", err));

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'notes-app',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    transformation: [{ width: 1200, quality: 'auto', fetch_format: 'auto' }],
  },
});

const upload = multer({ storage });

function isLoggedIn(req, res, next) {
  if (req.cookies.token) {
    try {
      jwt.verify(req.cookies.token, process.env.JWT_SECRET || 'jwt_secret');
      return next();
    } catch (err) {
      req.flash('error', 'Invalid token.');
      return res.redirect('/login');
    }
  }
  req.flash('error', 'You must be logged in.');
  res.redirect('/login');
}


app.get('/register', (req, res) => {
  res.render('register');
});

app.post('/register', async (req, res) => {
  try {
    const { username, email, password, age } = req.body;
    let user = await User.findOne({ email });
    if (user) {
      req.flash('error', 'User already exists');
      return res.redirect('/register');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    user = await User.create({
      username,
      email,
      password: hashedPassword,
      age
    });

    const token = jwt.sign({ email: user.email, userid: user._id }, process.env.JWT_SECRET || 'jwt_secret');
    res.cookie('token', token);
    req.flash('success', 'Registered successfully');
    res.redirect('/');
  } catch (err) {
    console.error('REGISTER ERROR:', err.message, err);
    req.flash('error', 'Error registering user: ' + err.message);
    res.redirect('/register');
  }
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      req.flash('error', 'Invalid email or password');
      return res.redirect('/login');
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      req.flash('error', 'Invalid email or password');
      return res.redirect('/login');
    }

    const token = jwt.sign({ email: user.email, userid: user._id }, process.env.JWT_SECRET || 'jwt_secret');
    res.cookie('token', token);
    req.flash('success', 'Logged in successfully');
    res.redirect('/');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Error logging in');
    res.redirect('/login');
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('token');
  req.flash('success', 'Logged out successfully');
  res.redirect('/login');
});

app.post('/notes', isLoggedIn, upload.single('media'), async (req, res) => {
  try {
    const { title, content } = req.body;

    if (!title || !content) {
      req.flash('error', 'Title and content are required');
      return res.redirect('/');
    }

    await Note.create({
      title,
      content,
      media: req.file ? req.file.path : null,
      user: res.locals.user.userid
    });

    req.flash('success', 'Note created successfully');
    res.redirect("/");
  } catch (error) {
    console.error(error);
    req.flash('error', "Error creating note");
    res.redirect("/");
  }
});

app.get("/", async (req, res) => {
  try {
    let page = parseInt(req.query.page) || 1;
    let limit = 5;
    let sort = req.query.sort || 'newest';
    let search = req.query.search ? req.query.search.trim() : '';

    let sortOptions = { createdAt: -1 };
    if (sort === 'oldest') {
      sortOptions = { createdAt: 1 };
    }

    if (!res.locals.user) {
      return res.render('index', {
        notes: [],
        currentPage: 1,
        totalPages: 0,
        totalNotes: 0,
        sort,
        search
      });
    }

    const query = { user: res.locals.user.userid };

    if (search) {
      const regex = new RegExp(search, 'i');
      query.$or = [{ title: regex }, { content: regex }];
    }

    const totalNotes = await Note.countDocuments(query);
    const totalPages = Math.ceil(totalNotes / limit);

    if (totalPages > 0 && page > totalPages) page = totalPages;

    const notes = await Note.find(query)
      .sort(sortOptions)
      .skip((page - 1) * limit)
      .limit(limit);

    res.render('index', {
      notes,
      currentPage: page,
      totalPages,
      totalNotes,
      sort,
      search
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching notes");
  }
});


app.get("/notes/:id", async (req, res) => {
  try {
    if (!res.locals.user) {
      req.flash('error', "You must be logged in.");
      return res.redirect('/login');
    }

    const { id } = req.params;
    const note = await Note.findOne({ _id: id, user: res.locals.user.userid });

    if (!note) {
      req.flash('error', "Note not found or unauthorized");
      return res.redirect('/');
    }

    res.render('show', { note });
  } catch (err) {
    console.error(err);
    req.flash('error', "Error fetching note");
    res.redirect('/');
  }
});

app.post("/delete/:id", isLoggedIn, async (req, res) => {
  try {
    const { id } = req.params;
    const deletedNote = await Note.findOneAndDelete({ _id: id, user: res.locals.user.userid });

    if (!deletedNote) {
      req.flash('error', "Note not found");
      return res.redirect('/');
    }

    req.flash('success', "Note deleted");
    res.redirect("/");
  } catch (err) {
    console.error(err);
    req.flash('error', "Error deleting note");
    res.redirect('/');
  }
});
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
