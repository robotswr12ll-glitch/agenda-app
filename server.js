require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const db = require('./database');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize users
async function initUsers() {
  const users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
  
  for (let u of users) {
    const hashedPassword = bcrypt.hashSync(u.password, 10);
    await db.run(
      'INSERT INTO users (username, password, name, role, title) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (username) DO NOTHING',
      [u.username, hashedPassword, u.name, u.role, u.title]
    );
  }
  
  console.log('Users initialized');
}

initUsers().catch(console.error);

// Auth middleware
function auth(req, res, next) {
  const userId = req.headers['user-id'];
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  
  db.get('SELECT id, username, name, role, title FROM users WHERE id = $1', [userId])
    .then(user => {
      if (!user) return res.status(401).json({ error: 'Invalid user' });
      req.user = user;
      next();
    })
    .catch(err => {
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    });
}

// Helper: Check if time ranges overlap
function timesOverlap(start1, end1, start2, end2) {
  return start1 < end2 && end1 > start2;
}

// Helper: Get next available time for a room
async function getNextAvailableTime(roomName, date) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const currentTime = now.toTimeString().slice(0, 5);
  
  const bookings = await db.all(
    'SELECT start_time, end_time FROM room_bookings WHERE room_name = $1 AND date = $2 AND end_time > $3 ORDER BY start_time',
    [roomName, date, currentTime]
  );
  
  if (bookings.length === 0) return null;
  
  let checkTime = date === today ? currentTime : '00:00';
  
  for (let booking of bookings) {
    if (checkTime < booking.start_time) {
      return checkTime;
    }
    checkTime = booking.end_time;
  }
  
  return checkTime;
}

// Routes

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const user = await db.get('SELECT * FROM users WHERE username = $1', [username]);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    res.json({
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      title: user.title
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get all users
app.get('/api/users', auth, async (req, res) => {
  try {
    const users = await db.all('SELECT id, name, role, title FROM users');
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// Check-in
app.post('/api/checkin', auth, async (req, res) => {
  const { status } = req.body;
  const today = new Date().toISOString().split('T')[0];
  
  try {
    await db.run(
      'INSERT INTO checkins (user_id, status, date) VALUES ($1, $2, $3) ON CONFLICT (user_id, date) DO UPDATE SET status = $2',
      [req.user.id, status, today]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Check-in failed' });
  }
});

app.get('/api/checkins/today', auth, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  
  try {
    const checkins = await db.all(
      'SELECT u.id, u.name, u.title, c.status FROM users u LEFT JOIN checkins c ON u.id = c.user_id AND c.date = $1',
      [today]
    );
    res.json(checkins);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load check-ins' });
  }
});

// Agenda items
app.get('/api/agenda/:date', auth, async (req, res) => {
  const date = req.params.date;
  
  try {
    // Get user's own agenda items
    const items = await db.all(
      'SELECT a.*, u.name as assigned_by_name FROM agenda_items a LEFT JOIN users u ON a.assigned_by = u.id WHERE a.user_id = $1 AND a.date = $2 ORDER BY a.time',
      [req.user.id, date]
    );
    
    // Get meetings where user is an attendee
    const meetings = await db.all(
      `SELECT r.*, u.name as organizer_name,
        (SELECT string_agg(u2.name, ', ') FROM booking_attendees ba2 JOIN users u2 ON ba2.user_id = u2.id WHERE ba2.booking_id = r.id) as attendee_names
       FROM room_bookings r
       JOIN booking_attendees ba ON r.id = ba.booking_id
       JOIN users u ON r.user_id = u.id
       WHERE ba.user_id = $1 AND r.date = $2
       ORDER BY r.start_time`,
      [req.user.id, date]
    );
    
    // Format meetings as agenda items
    const meetingItems = meetings.map(m => ({
      id: 'meeting_' + m.id,
      time: m.start_time,
      description: `Meeting: ${m.room_name} (organized by ${m.organizer_name})`,
      room: `Until ${m.end_time}`,
      is_done: 0,
      assigned_by_name: m.organizer_name,
      is_meeting: true,
      attendee_names: m.attendee_names
    }));
    
    // Combine and sort by time
    const allItems = [...items, ...meetingItems].sort((a, b) => {
      return a.time.localeCompare(b.time);
    });
    
    res.json(allItems);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load agenda' });
  }
});

// Get dates with agenda items for calendar
app.get('/api/agenda-month/:year/:month', auth, async (req, res) => {
  const { year, month } = req.params;
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-31`;
  
  try {
    const dates = await db.all(
      'SELECT DISTINCT date FROM agenda_items WHERE user_id = $1 AND date BETWEEN $2 AND $3',
      [req.user.id, startDate, endDate]
    );
    res.json(dates.map(d => d.date));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load dates' });
  }
});

app.post('/api/agenda', auth, async (req, res) => {
  const { date, time, description, room } = req.body;
  
  try {
    const result = await db.run(
      'INSERT INTO agenda_items (user_id, date, time, description, room) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [req.user.id, date, time, description, room || '']
    );
    res.json({ id: result.lastInsertRowid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add item' });
  }
});

app.put('/api/agenda/:id/toggle', auth, async (req, res) => {
  try {
    await db.run(
      'UPDATE agenda_items SET is_done = NOT is_done WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to toggle item' });
  }
});

// Admin: Assign task
app.post('/api/admin/assign', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'ceo') {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  const { user_id, date, time, description } = req.body;
  
  try {
    await db.run(
      'INSERT INTO agenda_items (user_id, date, time, description, assigned_by) VALUES ($1, $2, $3, $4, $5)',
      [user_id, date, time, description, req.user.id]
    );
    
    // Create notification
    await db.run(
      'INSERT INTO notifications (user_id, message) VALUES ($1, $2)',
      [user_id, `${req.user.name} assigned you: ${description}`]
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to assign task' });
  }
});

// Rooms - Get all with availability
app.get('/api/rooms', auth, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toTimeString().slice(0, 5);
  
  const rooms = [
    { name: 'Maple', seats: 4 },
    { name: 'Cedar', seats: 8 },
    { name: 'Birch', seats: 6 },
    { name: 'Willow', seats: 12 },
    { name: 'Aspen', seats: 2 },
    { name: 'Rowan', seats: 6 }
  ];
  
  try {
    for (let room of rooms) {
      const bookings = await db.all(
        'SELECT r.*, u.name as user_name FROM room_bookings r JOIN users u ON r.user_id = u.id WHERE r.room_name = $1 AND r.date = $2 AND r.end_time > $3 ORDER BY r.start_time',
        [room.name, today, now]
      );
      
      if (bookings.length === 0) {
        room.status = 'free';
        room.next_available = null;
      } else {
        const current = bookings.find(b => b.start_time <= now && b.end_time > now);
        if (current) {
          room.status = current.user_id === req.user.id ? 'mine' : 'taken';
          room.current_booking = current;
          room.next_available = await getNextAvailableTime(room.name, today);
        } else {
          room.status = 'free';
          room.next_available = bookings[0].start_time;
        }
      }
      
      room.today_bookings = bookings;
    }
    
    res.json(rooms);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load rooms' });
  }
});

// Book room with attendees
app.post('/api/rooms/book', auth, async (req, res) => {
  const { room_name, date, start_time, end_time, attendees } = req.body;
  
  if (!date || !start_time || !end_time) {
    return res.status(400).json({ error: 'Date, start time, and end time required' });
  }
  
  if (start_time >= end_time) {
    return res.status(400).json({ error: 'End time must be after start time' });
  }
  
  try {
    // Check for conflicts
    const conflicts = await db.all(
      'SELECT r.*, u.name as user_name FROM room_bookings r JOIN users u ON r.user_id = u.id WHERE r.room_name = $1 AND r.date = $2',
      [room_name, date]
    );
    
    for (let booking of conflicts) {
      if (timesOverlap(start_time, end_time, booking.start_time, booking.end_time)) {
        return res.status(400).json({ 
          error: `Room already booked by ${booking.user_name} from ${booking.start_time} to ${booking.end_time}` 
        });
      }
    }
    
    // Create booking
    const result = await db.run(
      'INSERT INTO room_bookings (room_name, user_id, date, start_time, end_time) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [room_name, req.user.id, date, start_time, end_time]
    );
    
    const bookingId = result.lastInsertRowid;
    
    // Handle attendees
    let attendeeIds = [];
    if (attendees && attendees.includes('everyone')) {
      const allUsers = await db.all('SELECT id FROM users WHERE id != $1', [req.user.id]);
      attendeeIds = allUsers.map(u => u.id);
    } else if (attendees && attendees.length > 0) {
      attendeeIds = attendees.filter(id => id !== req.user.id);
    }
    
    // Add attendees to junction table
    for (let uid of attendeeIds) {
      await db.run(
        'INSERT INTO booking_attendees (booking_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [bookingId, uid]
      );
    }
    
    // Notify attendees
    for (let uid of attendeeIds) {
      await db.run(
        'INSERT INTO notifications (user_id, message) VALUES ($1, $2)',
        [uid, `${req.user.name} invited you to ${room_name} on ${date} from ${start_time} to ${end_time}`]
      );
    }
    
    // Notify non-attendees about room booking (if not @everyone)
    if (!attendees || !attendees.includes('everyone')) {
      const nonAttendees = await db.all(
        'SELECT id FROM users WHERE id != $1 AND id NOT IN (SELECT unnest($2::int[]))',
        [req.user.id, attendeeIds]
      );
      for (let u of nonAttendees) {
        await db.run(
          'INSERT INTO notifications (user_id, message) VALUES ($1, $2)',
          [u.id, `${req.user.name} booked ${room_name} on ${date} from ${start_time} to ${end_time}`]
        );
      }
    }
    
    res.json({ success: true, booking_id: bookingId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to book room' });
  }
});

// Get all bookings (for Sarah's dashboard)
app.get('/api/bookings/all', auth, async (req, res) => {
  if (req.user.role !== 'desk') {
    return res.status(403).json({ error: 'Only front desk can view all bookings' });
  }
  
  try {
    const bookings = await db.all(
      'SELECT r.*, u.name as user_name, u.title as user_title FROM room_bookings r JOIN users u ON r.user_id = u.id ORDER BY r.date DESC, r.start_time DESC'
    );
    
    // Get attendees for each booking
    for (let b of bookings) {
      const attendees = await db.all(
        'SELECT u.name FROM booking_attendees ba JOIN users u ON ba.user_id = u.id WHERE ba.booking_id = $1',
        [b.id]
      );
      b.attendees = attendees.map(a => a.name);
    }
    
    res.json(bookings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load bookings' });
  }
});

// Delete booking
app.delete('/api/bookings/:id', auth, async (req, res) => {
  if (req.user.role !== 'desk') {
    return res.status(403).json({ error: 'Only front desk can delete bookings' });
  }
  
  try {
    const booking = await db.get(
      'SELECT r.*, u.name as user_name FROM room_bookings r JOIN users u ON r.user_id = u.id WHERE r.id = $1',
      [req.params.id]
    );
    
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    // Get attendees to notify them
    const attendees = await db.all(
      'SELECT u.id, u.name FROM booking_attendees ba JOIN users u ON ba.user_id = u.id WHERE ba.booking_id = $1',
      [req.params.id]
    );
    
    await db.run('DELETE FROM room_bookings WHERE id = $1', [req.params.id]);
    
    // Notify booker
    await db.run(
      'INSERT INTO notifications (user_id, message) VALUES ($1, $2)',
      [booking.user_id, `Your meeting in ${booking.room_name} on ${booking.date} (${booking.start_time}-${booking.end_time}) was cancelled`]
    );
    
    // Notify attendees
    for (let a of attendees) {
      await db.run(
        'INSERT INTO notifications (user_id, message) VALUES ($1, $2)',
        [a.id, `Meeting in ${booking.room_name} on ${booking.date} (${booking.start_time}-${booking.end_time}) was cancelled`]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete booking' });
  }
});

// Notifications
app.get('/api/notifications', auth, async (req, res) => {
  try {
    const notifications = await db.all(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    );
    
    const unreadResult = await db.get(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND is_read = 0',
      [req.user.id]
    );
    
    res.json({ notifications, unread: parseInt(unreadResult.count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

app.post('/api/notifications/read', auth, async (req, res) => {
  try {
    await db.run(
      'UPDATE notifications SET is_read = 1 WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark notifications read' });
  }
});

// Chat (in-memory)
let chatMessages = { 'Team': [], 'Admin': [] };

app.get('/api/chat/:channel', auth, (req, res) => {
  const channel = req.params.channel;
  if (!chatMessages[channel]) chatMessages[channel] = [];
  res.json(chatMessages[channel].slice(-50));
});

app.post('/api/chat/:channel', auth, (req, res) => {
  const channel = req.params.channel;
  const { message } = req.body;
  
  if (!chatMessages[channel]) chatMessages[channel] = [];
  
  chatMessages[channel].push({
    user: req.user.name,
    message,
    time: new Date().toISOString()
  });
  
  if (chatMessages[channel].length > 100) {
    chatMessages[channel] = chatMessages[channel].slice(-100);
  }
  
  res.json({ success: true });
});

// Leave requests
app.get('/api/leave', auth, async (req, res) => {
  try {
    const requests = await db.all(
      'SELECT l.*, u.name as user_name FROM leave_requests l JOIN users u ON l.user_id = u.id WHERE l.user_id = $1 OR $2 IN (\'admin\', \'ceo\') ORDER BY l.created_at DESC',
      [req.user.id, req.user.role]
    );
    res.json(requests);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load leave requests' });
  }
});

app.post('/api/leave', auth, async (req, res) => {
  const { type, start_date, end_date } = req.body;
  
  try {
    await db.run(
      'INSERT INTO leave_requests (user_id, type, start_date, end_date) VALUES ($1, $2, $3, $4)',
      [req.user.id, type, start_date, end_date]
    );
    
    // Notify admins
    const admins = await db.all("SELECT id FROM users WHERE role IN ('admin', 'ceo')");
    for (let a of admins) {
      await db.run(
        'INSERT INTO notifications (user_id, message) VALUES ($1, $2)',
        [a.id, `${req.user.name} requested ${type} from ${start_date} to ${end_date}`]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit leave request' });
  }
});

app.post('/api/leave/:id/decide', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'ceo') {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  const { approved } = req.body;
  
  try {
    const request = await db.get('SELECT * FROM leave_requests WHERE id = $1', [req.params.id]);
    
    await db.run(
      'UPDATE leave_requests SET status = $1 WHERE id = $2',
      [approved ? 'Approved' : 'Declined', req.params.id]
    );
    
    // Notify requester
    await db.run(
      'INSERT INTO notifications (user_id, message) VALUES ($1, $2)',
      [request.user_id, `Your ${request.type} request was ${approved ? 'approved' : 'declined'}`]
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// Announcements
app.get('/api/announcements', auth, async (req, res) => {
  try {
    const announcements = await db.all(
      'SELECT a.*, u.name as author FROM announcements a JOIN users u ON a.user_id = u.id ORDER BY a.created_at DESC LIMIT 10'
    );
    res.json(announcements);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load announcements' });
  }
});

app.post('/api/announcements', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'ceo') {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  const { content } = req.body;
  
  try {
    await db.run(
      'INSERT INTO announcements (user_id, content) VALUES ($1, $2)',
      [req.user.id, content]
    );
    
    // Notify all users
    const allUsers = await db.all('SELECT id FROM users WHERE id != $1', [req.user.id]);
    for (let u of allUsers) {
      await db.run(
        'INSERT INTO notifications (user_id, message) VALUES ($1, $2)',
        [u.id, `New announcement: ${content}`]
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to post announcement' });
  }
});

// Visitors
app.get('/api/visitors', auth, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  
  try {
    const visitors = await db.all(
      'SELECT v.*, u.name as host_name FROM visitors v JOIN users u ON v.host_id = u.id WHERE v.date = $1 ORDER BY v.created_at DESC',
      [today]
    );
    res.json(visitors);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load visitors' });
  }
});

app.post('/api/visitors', auth, async (req, res) => {
  if (req.user.role !== 'desk') {
    return res.status(403).json({ error: 'Only front desk can add visitors' });
  }
  
  const { name, host_id } = req.body;
  const today = new Date().toISOString().split('T')[0];
  
  try {
    await db.run(
      'INSERT INTO visitors (name, host_id, date) VALUES ($1, $2, $3)',
      [name, host_id, today]
    );
    
    // Notify host
    await db.run(
      'INSERT INTO notifications (user_id, message) VALUES ($1, $2)',
      [host_id, `Visitor ${name} is here to see you`]
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add visitor' });
  }
});

app.put('/api/visitors/:id/status', auth, async (req, res) => {
  if (req.user.role !== 'desk') {
    return res.status(403).json({ error: 'Only front desk can update visitors' });
  }
  
  const { status } = req.body;
  
  try {
    await db.run(
      'UPDATE visitors SET status = $1 WHERE id = $2',
      [status, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update visitor' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Login with one of the users from users.json');
});
