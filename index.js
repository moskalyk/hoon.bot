require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const bodyParser = require('body-parser');
const fs = require('fs/promises');
const path = require('path');
const fetch = require('cross-fetch');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
console.log(accountSid)
console.log(authToken)
const client = twilio(accountSid, authToken);
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const DB_PATH = path.join(__dirname, 'database.json');

// Arena API Configuration
const channels = [
  'hoon-academy-0', 'hoon-academy-1', 'hoon-academy-2',
  'hoon-academy-3', 'hoon-academy-4', 'hoon-academy-5',
  'hoon-academy-6', 'hoon-academy-7', 'hoon-academy-8'
];

async function fetchArenaContent(lessonWeights) {
  const fetchWithRetry = async (retryCount = 0, maxRetries = 10) => {
    try {
      // Select channel based on weights
      const activeChannels = lessonWeights
        .map((weight, index) => weight === 1 ? channels[index] : null)
        .filter(channel => channel !== null);
      
      const selectedChannel = activeChannels[Math.floor(Math.random() * activeChannels.length)];
      console.log(selectedChannel)
      const res = await fetch(`https://api.are.na/v2/channels/${selectedChannel}/contents`);
      if (res.ok) {
        const contents = await res.json();
        const content = contents.contents[Math.floor(Math.random() * contents.contents.length)];
        const html = content.content_html || 'No content available';
        const encodedHtml = Buffer.from(html).toString('base64');
        return {
          html,
          url: `${BASE_URL}/content/${encodedHtml}`
        };
      } else if (res.status === 404 && retryCount < maxRetries) {
        return fetchWithRetry(retryCount + 1, maxRetries);
      }
      throw new Error(`API call failed with status: ${res.status}`);
    } catch (error) {
      if (retryCount < maxRetries) return fetchWithRetry(retryCount + 1, maxRetries);
      throw error;
    }
  };
  
  return fetchWithRetry();
}

// Database operations
async function readDatabase() {
  try {
    const data = await fs.readFile(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return { users: {} };
  }
}

async function writeDatabase(data) {
  await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2));
}

// Command handlers
async function handleBegin(phoneNumber, params) {
  const db = await readDatabase();
  const hours = params[0] ? parseInt(params[0]) : null;
  
  db.users[phoneNumber] = {
    active: true,
    sendIntervals: [3600000], // Default 1 hour
    lessonWeights: Array(9).fill(1), // All lessons enabled by default
    messageCount: 0,
    endTime: hours ? Date.now() + (hours * 3600000) : null,
    nextSendTime: Date.now(),
    currentIntervalIndex: 0
  };
  
  await writeDatabase(db);
  return "Service started! You'll receive Hoon Academy nuggets hourly.";
}

async function handleStop(phoneNumber, params) {
  const db = await readDatabase();
  if (params[0] === 'in' || params[0] === 'for') {
    const hours = parseInt(params[1]);
    if (!isNaN(hours) && hours > 0) {
      db.users[phoneNumber].endTime = Date.now() + (hours * 3600000);
      await writeDatabase(db);
      return `Service will stop in ${hours} hours.`;
    }
    return "Please specify a valid number of hours.";
  }
  
  db.users[phoneNumber].active = false;
  await writeDatabase(db);
  return "Service stopped. Text :begin to start again.";
}

async function handleSync(phoneNumber, params) {
  const db = await readDatabase();
  try {
    // Parse array of intervals from params
    const intervals = params.map(p => {
      const hours = parseInt(p);
      if (isNaN(hours) || hours < 1 || hours > 72) throw new Error();
      return hours * 3600000; // Convert to milliseconds
    });
    
    db.users[phoneNumber].sendIntervals = intervals;
    db.users[phoneNumber].currentIntervalIndex = 0;
    await writeDatabase(db);
    return `Messages will now be sent with intervals: ${params.join(', ')} hours`;
  } catch {
    return "Please provide valid intervals between 1-72 hours, e.g., ':sync 1 2 4'";
  }
}

async function handleSlow(phoneNumber, params) {
  const db = await readDatabase();
  const factor = parseInt(params[0]);
  if (!isNaN(factor) && factor >= 0 && factor <= 30) {
    db.users[phoneNumber].sendIntervals = db.users[phoneNumber].sendIntervals.map(
      interval => interval * (1 + factor)
    );
    await writeDatabase(db);
    return `Message intervals have been increased by ${factor}x.`;
  }
  return "Please specify a number between 0 and 30.";
}

async function handleLessons(phoneNumber, params) {
  const db = await readDatabase();
  try {
    const selections = params.map(p => {
      const num = parseInt(p);
      if (isNaN(num) || num < 0 || num > 8) throw new Error();
      return num;
    });
    
    const weights = Array(9).fill(0);
    selections.forEach(lessonNum => {
      weights[lessonNum] = 1;
    });
    
    db.users[phoneNumber].lessonWeights = weights;
    await writeDatabase(db);

    const selectedLessons = weights.map((w, i) => w === 1 ? i : null).filter(i => i !== null);
    return `Now sending content from lessons: ${selectedLessons.join(', ')}`;
  } catch {
    return "Please provide valid lesson numbers between 0-8, e.g., ':lessons 1' or ':lessons 1 2 3'";
  }
}

const HELP_MESSAGE = `
Available commands:
:begin - Start receiving messages
:begin [hours] - Start for specific duration
:stop - Stop messages
:stop in/for [hours] - Schedule stop
:sync [hours...] - Set staggered message intervals
:slow [0-30] - Reduce message frequency
:lessons [numbers] - Select which lessons to receive (0-8)
:help - Show this message

Examples:
:sync 1 2 4 - Send messages every 1, then 2, then 4 hours
:lessons 1 2 - Only receive content from lessons 1 and 2
:lessons 0 - Only receive content from lesson 0
`;

// Content endpoint
app.get('/content/:html', (req, res) => {
  try {
    const html = Buffer.from(req.params.html, 'base64').toString();
    res.send(html);
  } catch {
    res.status(400).send('Invalid content');
  }
});

// Add these near the top of your file with other requires
const router = express.Router();

// Validation middleware
const validatePhoneNumber = (req, res, next) => {
  const { phoneNumber } = req.body;
  
  // Basic validation - just check if it starts with + and contains only numbers after that
  if (!phoneNumber || !phoneNumber.startsWith('+') || !/^\+\d+$/.test(phoneNumber)) {
    return res.status(400).json({
      error: "Invalid phone number format. Please include country code with + prefix"
    });
  }
  next();
};

// Signup route
router.post('/signup', validatePhoneNumber, async (req, res) => {
  const { phoneNumber } = req.body;
  
  try {
    // Check if user already exists
    const db = await readDatabase();
    if (db.users[phoneNumber]) {
      return res.status(409).json({
        error: "This phone number is already registered"
      });
    }

    // Initialize user in database with default settings
    db.users[phoneNumber] = {
      active: true,
      sendIntervals: [3600000], // Default 1 hour
      lessonWeights: Array(9).fill(1), // All lessons enabled by default
      messageCount: 0,
      nextSendTime: Date.now(),
      currentIntervalIndex: 0
    };
    
    await writeDatabase(db);

    // Send welcome message
    const welcomeMessage = 
      "howdy, welcome to hoon bot\n\n" +

      "text us with a command to program us to return May ‘24 hoon academy nuggets, timely\n\n" +

      "the default is all the sessions (0-8), hourly \n\n" +
      "Available commands:\n" +
      `
      :begin - Start receiving messages
      :begin [hours] - Start for specific duration
      :stop - Stop messages
      :stop in/for [hours] - Schedule stop
      :sync [hours...] - Set hourly message intervals, e.g. :sync 1 2 1 
      :slow [0-30] - Reduce message frequency
      :lessons [numbers] - Select which lessons to receive (0-8)
      :help - Show this message\n
      `+
      "Your first nugget will arrive shortly!";

    await client.messages.create({
      body: welcomeMessage,
      to: phoneNumber,
      from: twilioNumber
    });

    // Send first content immediately
    const content = await fetchArenaContent(db.users[phoneNumber].lessonWeights);
    await client.messages.create({
      body: `Here's your first Hoon Academy nugget: ${content.url}`,
      to: phoneNumber,
      from: twilioNumber
    });

    res.status(200).json({
      message: "Signup successful! Welcome messages sent.",
      phoneNumber
    });

  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({
      error: "Failed to complete signup. Please try again."
    });
  }
});

// Add route for checking signup status
router.get('/status/:phoneNumber', validatePhoneNumber, async (req, res) => {
  const { phoneNumber } = req.params;
  
  try {
    const db = await readDatabase();
    const user = db.users[phoneNumber];
    
    if (!user) {
      return res.status(404).json({
        error: "Phone number not found"
      });
    }

    res.status(200).json({
      active: user.active,
      messageCount: user.messageCount,
      nextMessageIn: Math.max(0, user.nextSendTime - Date.now()),
      activeLessons: user.lessonWeights
        .map((weight, index) => weight === 1 ? index : null)
        .filter(lesson => lesson !== null)
    });

  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({
      error: "Failed to fetch status. Please try again."
    });
  }
});

// Add this near your other app configurations
app.use('/api', router);

// Message handling endpoint
app.post('/sms', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const { Body: message, From: phoneNumber } = req.body;

  if (message.toLowerCase() === 'yes' || message.toLowerCase() === 'no') {
    const db = await readDatabase();
    if (db.users[phoneNumber]?.messageCount >= 100) {
      if (message.toLowerCase() === 'yes') {
        db.users[phoneNumber].sendIntervals = db.users[phoneNumber].sendIntervals.map(
          interval => interval * 2
        );
        await writeDatabase(db);
        twiml.message('Message frequency has been reduced by half.');
      } else {
        twiml.message('Continuing with current frequency.');
      }
    }
  } else if (message.startsWith(':')) {
    const [command, ...params] = message.slice(1).split(' ');
    let response;

    switch (command) {
      case 'begin':
        response = await handleBegin(phoneNumber, params);
        break;
      case 'stop':
        response = await handleStop(phoneNumber, params);
        break;
      case 'sync':
        response = await handleSync(phoneNumber, params);
        break;
      case 'slow':
        response = await handleSlow(phoneNumber, params);
        break;
      case 'lessons':
        response = await handleLessons(phoneNumber, params);
        break;
      case 'help':
        response = HELP_MESSAGE;
        break;
      default:
        response = "Unknown command. Text :help for available commands.";
    }

    twiml.message(response);
  } else {
    twiml.message('Unknown command. Text :help for available commands.');
  }

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

// Message sending function
async function sendScheduledMessages() {
  const db = await readDatabase();
  const now = Date.now();

  for (const [phoneNumber, user] of Object.entries(db.users)) {
    if (!user.active || (user.endTime && now > user.endTime)) {
      user.active = false;
      continue;
    }

    if (now >= user.nextSendTime) {
      try {
        const content = await fetchArenaContent(user.lessonWeights);
        await client.messages.create({
          body: `Here's your Hoon Academy nugget: ${content.url}`,
          to: phoneNumber,
          from: twilioNumber
        });

        // Update next send time using staggered intervals
        const currentInterval = user.sendIntervals[user.currentIntervalIndex];
        user.currentIntervalIndex = (user.currentIntervalIndex + 1) % user.sendIntervals.length;
        user.nextSendTime = now + currentInterval;
        user.messageCount++;

        if (user.messageCount === 100) {
          await client.messages.create({
            body: "You've gotten 100 tid bits of knowledge, want to slow down? respond with yes or no",
            to: phoneNumber,
            from: twilioNumber
          });
        }
      } catch (error) {
        console.error(`Failed to send message to ${phoneNumber}:`, error);
      }
    }
  }

  await writeDatabase(db);
}

// Start the scheduler
setInterval(sendScheduledMessages, 60000); // Check every minute

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});