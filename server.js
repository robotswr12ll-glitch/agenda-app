require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const db = require('./database');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize users
async function initUsers() {
  const users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
  
  for (let u of users) {
    const hashedPassword = bcrypt.hashSync(u.password, 10);
    await db.prepare('INSERT INTO users (username, password, name, role, title) VALUES (?, ?, ?, ?, ?) ON CONFLICT (username) DO NOTHING')
      .run(u.username, hashedPassword, u.name, u.role, u.title);
  }
  
  console.log('Users initialized');
}

initUsers().catch(console.error);

// Auth middleware
function auth(req, res, next) {
  const userId = req.headers['user-id'];
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  
  const user = db.prepare('SELECT id, username, name, role, title FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(401).json({ error: 'Invalid user' });
  
  req.user = user;
  next();
}

// Helper: Check if time ranges overlap
function timesOverlap(start1, end1, start2, end2) {
  return start1 < end2 && end1 > start2;
}

// Helper: Get next available time for a room
function getNextAvailableTime(roomName, date) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const currentTime = now.toTimeString().slice(0, 5);
  
  const bookings = db.prepare(`
    SELECT start_time, end_time FROM room_bookings 
    WHERE room_name = ? AND date = ? AND end_time > ?
    ORDER BY start_time
  `).all(roomName, date, currentTime);
  
  if (bookings.length === 0) return null;
  
  // Find first gap
  let checkTime = date === today ? currentTime : '00:00';
  
  for (let booking of bookings) {
    if (checkTime < booking.start_time) {
      return checkTime; // Free until next booking starts
    }
    checkTime = booking.end_time;
  }
  
  return checkTime; // Free after last booking
}

// Routes

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
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
});

// Get all users
app.get('/api/users', auth, (req, res) => {
  const users = db.prepare('SELECT id, name, role, title FROM users').all();
  res.json(users);
});

// Check-in
app.post('/api/checkin', auth, (req, res) => {
  const { status } = req.body;
  const today = new Date().toISOString().split('T')[0];
  
  db.prepare('INSERT OR REPLACE INTO checkins (user_id, status, date) VALUES (?, ?, ?)')
    .run(req.user.id, status, today);
  
  res.json({ success: true });
});

app.get('/api/checkins/today', auth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const checkins = db.prepare(`
    SELECT u.id, u.name, u.title, c.status 
    FROM users u 
    LEFT JOIN checkins c ON u.id = c.user_id AND c.date = ?
  `).all(today);
  res.json(checkins);
});

// Agenda items
app.get('/api/agenda/:date', auth, (req, res) => {
  const items = db.prepare(`
    SELECT a.*, u.name as assigned_by_name 
    FROM agenda_items a 
    LEFT JOIN users u ON a.assigned_by = u.id
    WHERE a.user_id = ? AND a.date = ?
    ORDER BY a.time
  `).all(req.user.id, req.params.date);
  res.json(items);
});

app.post('/api/agenda', auth, (req, res) => {
  const { date, time, description, room } = req.body;
  
  const result = db.prepare(`
    INSERT INTO agenda_items (user_id, date, time, description, room)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.user.id, date, time, description, room || '');
  
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/agenda/:id/toggle', auth, (req, res) => {
  db.prepare('UPDATE agenda_items SET is_done = NOT is_done WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  res.json({ success: true });
});

// Admin: Assign task
app.post('/api/admin/assign', auth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'ceo') {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  const { user_id, date, time, description } = req.body;
  
  db.prepare(`
    INSERT INTO agenda_items (user_id, date, time, description, assigned_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(user_id, date, time, description, req.user.id);
  
  // Create notification
  db.prepare('INSERT INTO notifications (user_id, message) VALUES (?, ?)')
    .run(user_id, `${req.user.name} assigned you: ${description}`);
  
  res.json({ success: true });
});

// Rooms - Get all with availability
app.get('/api/rooms', auth, (req, res) => {
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
  
  rooms.forEach(room => {
    const bookings = db.prepare(`
      SELECT r.*, u.name as user_name 
      FROM room_bookings r
      JOIN users u ON r.user_id = u.id
      WHERE r.room_name = ? AND r.date = ? AND r.end_time > ?
      ORDER BY r.start_time
    `).all(room.name, today, now);
    
    if (bookings.length === 0) {
      room.status = 'free';
      room.next_available = null;
    } else {
      const current = bookings.find(b => b.start_time <= now && b.end_time > now);
      if (current) {
        room.status = current.user_id === req.user.id ? 'mine' : 'taken';
        room.current_booking = current;
        room.next_available = getNextAvailableTime(room.name, today);
      } else {
        room.status = 'free';
        room.next_available = bookings[0].start_time;
      }
    }
    
    room.today_bookings = bookings;
  });
  
  res.json(rooms);
});

// Book room with attendees
app.post('/api/rooms/book', auth, (req, res) => {
  const { room_name, date, start_time, end_time, attendees } = req.body;
  
  if (!date || !start_time || !end_time) {
    return res.status(400).json({ error: 'Date, start time, and end time required' });
  }
  
  if (start_time >= end_time) {
    return res.status(400).json({ error: 'End time must be after start time' });
  }
  
  // Check for conflicts
  const conflicts = db.prepare(`
    SELECT r.*, u.name as user_name FROM room_bookings r
    JOIN users u ON r.user_id = u.id
    WHERE r.room_name = ? AND r.date = ?
  `).all(room_name, date);
  
  for (let booking of conflicts) {
    if (timesOverlap(start_time, end_time, booking.start_time, booking.end_time)) {
      return res.status(400).json({ 
        error: `Room already booked by ${booking.user_name} from ${booking.start_time} to ${booking.end_time}` 
      });
    }
  }
  
  // Create booking
  const result = db.prepare(`
    INSERT INTO room_bookings (room_name, user_id, date, start_time, end_time)
    VALUES (?, ?, ?, ?, ?)
  `).run(room_name, req.user.id, date, start_time, end_time);
  
  const bookingId = result.lastInsertRowid;
  
  // Handle attendees
  let attendeeIds = [];
  if (attendees && attendees.includes('everyone')) {
    attendeeIds = db.prepare('SELECT id FROM users WHERE id != ?').all(req.user.id).map(u => u.id);
  } else if (attendees && attendees.length > 0) {
    attendeeIds = attendees.filter(id => id !== req.user.id);
  }
  
  // Add attendees to junction table
  const addAttendee = db.prepare('INSERT OR IGNORE INTO booking_attendees (booking_id, user_id) VALUES (?, ?)');
  attendeeIds.forEach(uid => addAttendee.run(bookingId, uid));
  
  // Notify attendees
  const notifyStmt = db.prepare('INSERT INTO notifications (user_id, message) VALUES (?, ?)');
  attendeeIds.forEach(uid => {
    notifyStmt.run(uid, `${req.user.name} invited you to ${room_name} on ${date} from ${start_time} to ${end_time}`);
  });
  
  // Notify non-attendees about room booking (if not @everyone)
  if (!attendees || !attendees.includes('everyone')) {
    const nonAttendees = db.prepare('SELECT id FROM users WHERE id != ? AND id NOT IN (SELECT value FROM json_each(?))')
      .all(req.user.id, JSON.stringify(attendeeIds));
    nonAttendees.forEach(u => {
      notifyStmt.run(u.id, `${req.user.name} booked ${room_name} on ${date} from ${start_time} to ${end_time}`);
    });
  }
  
  res.json({ success: true, booking_id: bookingId });
});

// Get all bookings (for Sarah's dashboard)
app.get('/api/bookings/all', auth, (req, res) => {
  if (req.user.role !== 'desk') {
    return res.status(403).json({ error: 'Only front desk can view all bookings' });
  }
  
  const bookings = db.prepare(`
    SELECT r.*, u.name as user_name, u.title as user_title
    FROM room_bookings r
    JOIN users u ON r.user_id = u.id
    ORDER BY r.date DESC, r.start_time DESC
  `).all();
  
  // Get attendees for each booking
  const attendeeStmt = db.prepare(`
    SELECT u.name FROM booking_attendees ba
    JOIN users u ON ba.user_id = u.id
    WHERE ba.booking_id = ?
  `);
  
  bookings.forEach(b => {
    b.attendees = attendeeStmt.all(b.id).map(a => a.name);
  });
  
  res.json(bookings);
});

// Delete booking
app.delete('/api/bookings/:id', auth, (req, res) => {
  if (req.user.role !== 'desk') {
    return res.status(403).json({ error: 'Only front desk can delete bookings' });
  }
  
  const booking = db.prepare(`
    SELECT r.*, u.name as user_name FROM room_bookings r
    JOIN users u ON r.user_id = u.id
    WHERE r.id = ?
  `).get(req.params.id);
  
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  
  // Get attendees to notify them
  const attendees = db.prepare(`
    SELECT u.id, u.name FROM booking_attendees ba
    JOIN users u ON ba.user_id = u.id
    WHERE ba.booking_id = ?
  `).all(req.params.id);
  
  db.prepare('DELETE FROM room_bookings WHERE id = ?').run(req.params.id);
  
  // Notify booker
  db.prepare('INSERT INTO notifications (user_id, message) VALUES (?, ?)')
    .run(booking.user_id, `Your meeting in ${booking.room_name} on ${booking.date} (${booking.start_time}-${booking.end_time}) was cancelled`);
  
  // Notify attendees
  attendees.forEach(a => {
    db.prepare('INSERT INTO notifications (user_id, message) VALUES (?, ?)')
      .run(a.id, `Meeting in ${booking.room_name} on ${booking.date} (${booking.start_time}-${booking.end_time}) was cancelled`);
  });
  
  res.json({ success: true });
});

// Book room with time range
app.post('/api/rooms/book', auth, (req, res) => {
  const { room_name, date, start_time, end_time } = req.body;
  
  if (!date || !start_time || !end_time) {
    return res.status(400).json({ error: 'Date, start time, and end time required' });
  }
  
  if (start_time >= end_time) {
    return res.status(400).json({ error: 'End time must be after start time' });
  }
  
  // Check for conflicts
  const conflicts = db.prepare(`
    SELECT r.*, u.name as user_name FROM room_bookings r
    JOIN users u ON r.user_id = u.id
    WHERE r.room_name = ? AND r.date = ?
  `).all(room_name, date);
  
  for (let booking of conflicts) {
    if (timesOverlap(start_time, end_time, booking.start_time, booking.end_time)) {
      return res.status(400).json({ 
        error: `Room already booked by ${booking.user_name} from ${booking.start_time} to ${booking.end_time}` 
      });
    }
  }
  
  // Get agenda including meeting invitations
app.get('/api/agenda/:date', auth, (req, res) => {
  const date = req.params.date;
  
  // Get user's own agenda items
  const items = db.prepare(`
    SELECT a.*, u.name as assigned_by_name 
    FROM agenda_items a 
    LEFT JOIN users u ON a.assigned_by = u.id
    WHERE a.user_id = ? AND a.date = ?
    ORDER BY a.time
  `).all(req.user.id, date);
  
  // Get meetings where user is an attendee
  const meetings = db.prepare(`
    SELECT r.*, u.name as organizer_name,
      (SELECT GROUP_CONCAT(u2.name, ', ') FROM booking_attendees ba2 JOIN users u2 ON ba2.user_id = u2.id WHERE ba2.booking_id = r.id) as attendee_names
    FROM room_bookings r
    JOIN booking_attendees ba ON r.id = ba.booking_id
    JOIN users u ON r.user_id = u.id
    WHERE ba.user_id = ? AND r.date = ?
    ORDER BY r.start_time
  `).all(req.user.id, date);
  
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
});

  // Create booking
  db.prepare(`
    INSERT INTO room_bookings (room_name, user_id, date, start_time, end_time)
    VALUES (?, ?, ?, ?, ?)
  `).run(room_name, req.user.id, date, start_time, end_time);
  
  // Notify all users about room booking
  const allUsers = db.prepare('SELECT id FROM users WHERE id != ?').all(req.user.id);
  const notifyStmt = db.prepare('INSERT INTO notifications (user_id, message) VALUES (?, ?)');
  
  allUsers.forEach(u => {
    notifyStmt.run(u.id, `${req.user.name} booked ${room_name} on ${date} from ${start_time} to ${end_time}`);
  });
  
  res.json({ success: true });
});

// Get all bookings (for Sarah's dashboard)
app.get('/api/bookings/all', auth, (req, res) => {
  // Only desk role can see all
  if (req.user.role !== 'desk') {
    return res.status(403).json({ error: 'Only front desk can view all bookings' });
  }
  
  const bookings = db.prepare(`
    SELECT r.*, u.name as user_name, u.title as user_title
    FROM room_bookings r
    JOIN users u ON r.user_id = u.id
    ORDER BY r.date DESC, r.start_time DESC
  `).all();
  
  res.json(bookings);
});

// Delete booking (Sarah only)
app.delete('/api/bookings/:id', auth, (req, res) => {
  if (req.user.role !== 'desk') {
    return res.status(403).json({ error: 'Only front desk can delete bookings' });
  }
  
  const booking = db.prepare(`
    SELECT r.*, u.name as user_name FROM room_bookings r
    JOIN users u ON r.user_id = u.id
    WHERE r.id = ?
  `).get(req.params.id);
  
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  
  db.prepare('DELETE FROM room_bookings WHERE id = ?').run(req.params.id);
  
  // Notify the user whose booking was cancelled
  db.prepare('INSERT INTO notifications (user_id, message) VALUES (?, ?)')
    .run(booking.user_id, `Your meeting in ${booking.room_name} on ${booking.date} (${booking.start_time}-${booking.end_time}) was cancelled`);
  
  res.json({ success: true });
});

// Notifications
app.get('/api/notifications', auth, (req, res) => {
  const notifications = db.prepare(`
    SELECT * FROM notifications 
    WHERE user_id = ? 
    ORDER BY created_at DESC 
    LIMIT 20
  `).all(req.user.id);
  
  const unreadCount = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0')
    .get(req.user.id);
  
  res.json({ notifications, unread: unreadCount.count });
});

app.post('/api/notifications/read', auth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ success: true });
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
app.get('/api/leave', auth, (req, res) => {
  const requests = db.prepare(`
    SELECT l.*, u.name as user_name 
    FROM leave_requests l
    JOIN users u ON l.user_id = u.id
    WHERE l.user_id = ? OR ? IN ('admin', 'ceo')
    ORDER BY l.created_at DESC
  `).all(req.user.id, req.user.role);
  
  res.json(requests);
});

app.post('/api/leave', auth, (req, res) => {
  const { type, start_date, end_date } = req.body;
  
  db.prepare(`
    INSERT INTO leave_requests (user_id, type, start_date, end_date)
    VALUES (?, ?, ?, ?)
  `).run(req.user.id, type, start_date, end_date);
  
  // Notify admins
  const admins = db.prepare("SELECT id FROM users WHERE role IN ('admin', 'ceo')").all();
  const notifyStmt = db.prepare('INSERT INTO notifications (user_id, message) VALUES (?, ?)');
  
  admins.forEach(a => {
    notifyStmt.run(a.id, `${req.user.name} requested ${type} from ${start_date} to ${end_date}`);
  });
  
  res.json({ success: true });
});

app.post('/api/leave/:id/decide', auth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'ceo') {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  const { approved } = req.body;
  const request = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
  
  db.prepare('UPDATE leave_requests SET status = ? WHERE id = ?')
    .run(approved ? 'Approved' : 'Declined', req.params.id);
  
  // Notify requester
  db.prepare('INSERT INTO notifications (user_id, message) VALUES (?, ?)')
    .run(request.user_id, `Your ${request.type} request was ${approved ? 'approved' : 'declined'}`);
  
  res.json({ success: true });
});

// Announcements
app.get('/api/announcements', auth, (req, res) => {
  const announcements = db.prepare(`
    SELECT a.*, u.name as author 
    FROM announcements a
    JOIN users u ON a.user_id = u.id
    ORDER BY a.created_at DESC
    LIMIT 10
  `).all();
  res.json(announcements);
});

app.post('/api/announcements', auth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'ceo') {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  const { content } = req.body;
  db.prepare('INSERT INTO announcements (user_id, content) VALUES (?, ?)')
    .run(req.user.id, content);
  
  // Notify all users
  const allUsers = db.prepare('SELECT id FROM users WHERE id != ?').all(req.user.id);
  const notifyStmt = db.prepare('INSERT INTO notifications (user_id, message) VALUES (?, ?)');
  
  allUsers.forEach(u => {
    notifyStmt.run(u.id, `New announcement: ${content}`);
  });
  
  res.json({ success: true });
});

// Visitors
app.get('/api/visitors', auth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const visitors = db.prepare(`
    SELECT v.*, u.name as host_name 
    FROM visitors v
    JOIN users u ON v.host_id = u.id
    WHERE v.date = ?
    ORDER BY v.created_at DESC
  `).all(today);
  res.json(visitors);
});

app.post('/api/visitors', auth, (req, res) => {
  if (req.user.role !== 'desk') {
    return res.status(403).json({ error: 'Only front desk can add visitors' });
  }
  
  const { name, host_id } = req.body;
  const today = new Date().toISOString().split('T')[0];
  
  db.prepare('INSERT INTO visitors (name, host_id, date) VALUES (?, ?, ?)')
    .run(name, host_id, today);
  
  // Notify host
  db.prepare('INSERT INTO notifications (user_id, message) VALUES (?, ?)')
    .run(host_id, `Visitor ${name} is here to see you`);
  
  res.json({ success: true });
});

app.put('/api/visitors/:id/status', auth, (req, res) => {
  if (req.user.role !== 'desk') {
    return res.status(403).json({ error: 'Only front desk can update visitors' });
  }
  
  const { status } = req.body;
  db.prepare('UPDATE visitors SET status = ? WHERE id = ?')
    .run(status, req.params.id);
  
  res.json({ success: true });
});

// Get dates with agenda items for calendar dots
app.get('/api/agenda-month/:year/:month', auth, (req, res) => {
  const { year, month } = req.params;
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-31`;
  
  const dates = db.prepare(`
    SELECT DISTINCT date FROM agenda_items 
    WHERE user_id = ? AND date BETWEEN ? AND ?
  `).all(req.user.id, startDate, endDate);
  
  res.json(dates.map(d => d.date));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('Login with one of the users from users.json');
});