import sqlite3
import os
import secrets
import hashlib
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit

app = Flask(__name__, static_folder='.')
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

DB_FILE = 'database.db'
ADMIN_PASSWORD = 'admin123'

# --- Database Setup ---

def init_db():
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        
        # Users table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                points INTEGER DEFAULT 0,
                created_at TEXT
            )
        ''')
        
        # Issues table (updated with user_id)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS issues (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                type TEXT,
                location TEXT,
                lat REAL,
                lng REAL,
                description TEXT,
                image TEXT,
                date TEXT,
                status TEXT DEFAULT 'pending',
                points_awarded INTEGER DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        ''')
        
        # Rewards table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS rewards (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                points_required INTEGER NOT NULL,
                icon TEXT
            )
        ''')
        
        # User rewards (redeemed)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS user_rewards (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                reward_id TEXT,
                redeemed_at TEXT,
                given_by_admin INTEGER DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users (id),
                FOREIGN KEY (reward_id) REFERENCES rewards (id)
            )
        ''')
        
        # Migration: Add new columns if they don't exist
        try:
            cursor.execute("ALTER TABLE issues ADD COLUMN user_id TEXT")
        except sqlite3.OperationalError:
            pass
        try:
            cursor.execute("ALTER TABLE issues ADD COLUMN points_awarded INTEGER DEFAULT 0")
        except sqlite3.OperationalError:
            pass
            
        # Insert default rewards if empty
        cursor.execute("SELECT COUNT(*) FROM rewards")
        if cursor.fetchone()[0] == 0:
            default_rewards = [
                (secrets.token_hex(8), 'Bronze Reporter', 'Starting reporter badge', 50, '🥉'),
                (secrets.token_hex(8), 'Silver Guardian', 'Active community member', 200, '🥈'),
                (secrets.token_hex(8), 'Gold Champion', 'Top contributor', 500, '🥇'),
                (secrets.token_hex(8), 'Platinum Hero', 'Legendary reporter', 1000, '💎'),
                (secrets.token_hex(8), 'Coffee Voucher', 'Free coffee at local cafe', 100, '☕'),
                (secrets.token_hex(8), 'Movie Ticket', 'Free movie ticket', 300, '🎬'),
            ]
            cursor.executemany('''
                INSERT INTO rewards (id, name, description, points_required, icon) VALUES (?, ?, ?, ?, ?)
            ''', default_rewards)
        
        conn.commit()

init_db()

def get_db_connection():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def hash_password(password):
    return hashlib.sha256(password.encode()).hexdigest()

# --- Authentication Routes ---

@app.route('/api/auth/register', methods=['POST'])
def register():
    data = request.json
    username = data.get('username', '').strip()
    email = data.get('email', '').strip().lower()
    password = data.get('password', '')
    
    if not username or not email or not password:
        return jsonify({'error': 'All fields are required'}), 400
    
    if len(password) < 4:
        return jsonify({'error': 'Password must be at least 4 characters'}), 400
    
    conn = get_db_connection()
    
    # Check if user exists
    existing = conn.execute('SELECT id FROM users WHERE username = ? OR email = ?', (username, email)).fetchone()
    if existing:
        conn.close()
        return jsonify({'error': 'Username or email already exists'}), 400
    
    user_id = secrets.token_hex(8)
    password_hash = hash_password(password)
    
    conn.execute('''
        INSERT INTO users (id, username, email, password_hash, points, created_at)
        VALUES (?, ?, ?, ?, 0, ?)
    ''', (user_id, username, email, password_hash, datetime.now().isoformat()))
    conn.commit()
    conn.close()
    
    return jsonify({
        'message': 'Registration successful',
        'user': {'id': user_id, 'username': username, 'email': email, 'points': 0}
    }), 201

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.json
    email = data.get('email', '').strip().lower()
    password = data.get('password', '')
    
    conn = get_db_connection()
    user = conn.execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()
    conn.close()
    
    if not user or user['password_hash'] != hash_password(password):
        return jsonify({'error': 'Invalid email or password'}), 401
    
    return jsonify({
        'message': 'Login successful',
        'user': {
            'id': user['id'],
            'username': user['username'],
            'email': user['email'],
            'points': user['points']
        }
    })

@app.route('/api/users/<user_id>', methods=['GET'])
def get_user(user_id):
    conn = get_db_connection()
    user = conn.execute('SELECT id, username, email, points, created_at FROM users WHERE id = ?', (user_id,)).fetchone()
    conn.close()
    
    if not user:
        return jsonify({'error': 'User not found'}), 404
    
    return jsonify(dict(user))

# --- Leaderboard ---

@app.route('/api/leaderboard', methods=['GET'])
def get_leaderboard():
    conn = get_db_connection()
    users = conn.execute('''
        SELECT id, username, points, 
               (SELECT COUNT(*) FROM issues WHERE user_id = users.id) as total_reports,
               (SELECT COUNT(*) FROM issues WHERE user_id = users.id AND status = 'solved') as solved_reports
        FROM users 
        ORDER BY points DESC 
        LIMIT 20
    ''').fetchall()
    conn.close()
    
    return jsonify([dict(u) for u in users])

# --- Rewards ---

@app.route('/api/rewards', methods=['GET'])
def get_rewards():
    conn = get_db_connection()
    rewards = conn.execute('SELECT * FROM rewards ORDER BY points_required').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rewards])

@app.route('/api/users/<user_id>/rewards', methods=['GET'])
def get_user_rewards(user_id):
    conn = get_db_connection()
    rewards = conn.execute('''
        SELECT ur.*, r.name, r.description, r.icon, r.points_required
        FROM user_rewards ur
        JOIN rewards r ON ur.reward_id = r.id
        WHERE ur.user_id = ?
        ORDER BY ur.redeemed_at DESC
    ''', (user_id,)).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rewards])

@app.route('/api/admin/give-reward', methods=['POST'])
def admin_give_reward():
    data = request.json
    user_id = data.get('user_id')
    reward_id = data.get('reward_id')
    
    conn = get_db_connection()
    
    # Get reward info
    reward = conn.execute('SELECT * FROM rewards WHERE id = ?', (reward_id,)).fetchone()
    user = conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
    
    if not reward or not user:
        conn.close()
        return jsonify({'error': 'Invalid user or reward'}), 400
    
    if user['points'] < reward['points_required']:
        conn.close()
        return jsonify({'error': 'User does not have enough points'}), 400
    
    # Deduct points and give reward
    new_points = user['points'] - reward['points_required']
    conn.execute('UPDATE users SET points = ? WHERE id = ?', (new_points, user_id))
    
    conn.execute('''
        INSERT INTO user_rewards (id, user_id, reward_id, redeemed_at, given_by_admin)
        VALUES (?, ?, ?, ?, 1)
    ''', (secrets.token_hex(8), user_id, reward_id, datetime.now().isoformat()))
    
    conn.commit()
    conn.close()
    
    # Broadcast update
    socketio.emit('points_updated', {'user_id': user_id, 'points': new_points})
    
    return jsonify({'message': 'Reward given successfully', 'new_points': new_points})

# --- Issues Routes ---

@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)

@app.route('/api/issues', methods=['GET'])
def get_issues():
    conn = get_db_connection()
    issues = conn.execute('''
        SELECT i.*, u.username as reporter_name 
        FROM issues i 
        LEFT JOIN users u ON i.user_id = u.id 
        ORDER BY date DESC
    ''').fetchall()
    conn.close()
    return jsonify([dict(ix) for ix in issues])

@app.route('/api/issues', methods=['POST'])
def create_issue():
    data = request.json
    issue_id = secrets.token_hex(8)
    
    new_issue = (
        issue_id,
        data.get('user_id'),  # Can be None for anonymous
        data['type'],
        data['location'],
        data.get('lat'),
        data.get('lng'),
        data['description'],
        data.get('image'),
        data['date'],
        'pending',
        0  # points_awarded
    )
    
    conn = get_db_connection()
    conn.execute('''
        INSERT INTO issues (id, user_id, type, location, lat, lng, description, image, date, status, points_awarded)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', new_issue)
    conn.commit()
    
    # Get full issue with reporter name for broadcast
    issue = conn.execute('''
        SELECT i.*, u.username as reporter_name 
        FROM issues i 
        LEFT JOIN users u ON i.user_id = u.id 
        WHERE i.id = ?
    ''', (issue_id,)).fetchone()
    conn.close()
    
    # Broadcast new issue to all clients
    socketio.emit('new_issue', dict(issue))
    
    return jsonify({'message': 'Issue reported successfully', 'id': issue_id}), 201

@app.route('/api/issues/<id>/status', methods=['PUT'])
def update_status(id):
    new_status = request.json.get('status')
    
    conn = get_db_connection()
    issue = conn.execute('SELECT * FROM issues WHERE id = ?', (id,)).fetchone()
    
    if not issue:
        conn.close()
        return jsonify({'error': 'Issue not found'}), 404
    
    old_status = issue['status']
    points_to_award = 0
    
    # Award points based on status change
    if issue['user_id']:  # Only if reported by a registered user
        if old_status == 'pending' and new_status == 'in-progress':
            # Issue validated by admin - award 10 points
            if issue['points_awarded'] == 0:
                points_to_award = 10
        elif new_status == 'solved' and issue['points_awarded'] < 30:
            # Issue solved - award additional 20 points
            points_to_award = 20
    
    # Update issue
    total_points = issue['points_awarded'] + points_to_award
    conn.execute('UPDATE issues SET status = ?, points_awarded = ? WHERE id = ?', (new_status, total_points, id))
    
    # Award points to user
    if points_to_award > 0 and issue['user_id']:
        conn.execute('UPDATE users SET points = points + ? WHERE id = ?', (points_to_award, issue['user_id']))
        
        # Get updated user points
        user = conn.execute('SELECT points FROM users WHERE id = ?', (issue['user_id'],)).fetchone()
        socketio.emit('points_updated', {'user_id': issue['user_id'], 'points': user['points'], 'added': points_to_award})
    
    conn.commit()
    conn.close()
    
    # Broadcast status update
    socketio.emit('status_updated', {'issue_id': id, 'status': new_status, 'points_awarded': points_to_award})
    
    return jsonify({'message': 'Status updated', 'points_awarded': points_to_award})

@app.route('/api/issues/<id>', methods=['DELETE'])
def delete_issue(id):
    conn = get_db_connection()
    conn.execute('DELETE FROM issues WHERE id = ?', (id,))
    conn.commit()
    conn.close()
    
    socketio.emit('issue_deleted', {'issue_id': id})
    
    return jsonify({'message': 'Issue deleted'})

# --- Admin Routes ---

@app.route('/api/admin/users', methods=['GET'])
def get_all_users():
    conn = get_db_connection()
    users = conn.execute('''
        SELECT id, username, email, points, created_at,
               (SELECT COUNT(*) FROM issues WHERE user_id = users.id) as total_reports
        FROM users 
        ORDER BY points DESC
    ''').fetchall()
    conn.close()
    return jsonify([dict(u) for u in users])

@app.route('/api/admin/stats', methods=['GET'])
def get_stats():
    conn = get_db_connection()
    
    total_issues = conn.execute('SELECT COUNT(*) FROM issues').fetchone()[0]
    pending = conn.execute("SELECT COUNT(*) FROM issues WHERE status = 'pending'").fetchone()[0]
    in_progress = conn.execute("SELECT COUNT(*) FROM issues WHERE status = 'in-progress'").fetchone()[0]
    solved = conn.execute("SELECT COUNT(*) FROM issues WHERE status = 'solved'").fetchone()[0]
    total_users = conn.execute('SELECT COUNT(*) FROM users').fetchone()[0]
    total_points = conn.execute('SELECT COALESCE(SUM(points), 0) FROM users').fetchone()[0]
    
    conn.close()
    
    return jsonify({
        'total_issues': total_issues,
        'pending': pending,
        'in_progress': in_progress,
        'solved': solved,
        'total_users': total_users,
        'total_points_distributed': total_points
    })

# --- SocketIO Events ---

@socketio.on('connect')
def handle_connect():
    print('Client connected')

@socketio.on('disconnect')
def handle_disconnect():
    print('Client disconnected')

if __name__ == '__main__':
    import socket
    hostname = socket.gethostname()
    try:
        local_ip = socket.gethostbyname(hostname)
        print(f"\n  ╔════════════════════════════════════════════════════════╗")
        print(f"  ║  🌐 Local Problem Reporter Server Running!              ║")
        print(f"  ╠════════════════════════════════════════════════════════╣")
        print(f"  ║  💻 Local:   http://localhost:5000                     ║")
        print(f"  ║  📱 Network: http://{local_ip}:5000                  ║")
        print(f"  ╚════════════════════════════════════════════════════════╝\n")
    except:
        pass
    
    socketio.run(app, debug=True, host='0.0.0.0', port=5000, allow_unsafe_werkzeug=True)
