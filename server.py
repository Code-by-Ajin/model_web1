import sqlite3
import os
import secrets
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit
from werkzeug.security import generate_password_hash, check_password_hash
from functools import wraps

app = Flask(__name__, static_folder='.')

# CORS configuration
if os.environ.get('FLASK_ENV') == 'development':
    CORS(app, origins="*")
else:
    # For production - replace with your actual domain
    CORS(app, origins=["https://yourdomain.com", "http://yourdomain.com"])

socketio = SocketIO(app, cors_allowed_origins="*")

DB_FILE = 'database.db'

# Admin password from environment variable
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin123')

# Rate limiting (optional - requires flask-limiter)
try:
    from flask_limiter import Limiter
    from flask_limiter.util import get_remote_address
    
    limiter = Limiter(
        app=app,
        key_func=get_remote_address,
        default_limits=["200 per day", "50 per hour"],
        storage_uri="memory://"
    )
    print("✓ Rate limiting enabled")
except ImportError:
    print("⚠️ Warning: flask-limiter not installed. Rate limiting disabled.")
    print("Install with: pip install flask-limiter --break-system-packages")
    limiter = None

# ============================================
# DATABASE SETUP
# ============================================

def init_db():
    """Initialize database with tables and indexes"""
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
                created_at TEXT,
                last_login TEXT
            )
        ''')
        
        # Issues table
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
        
        # Create indexes for better performance
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_issues_user_id ON issues(user_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_issues_date ON issues(date DESC)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_user_rewards_user_id ON user_rewards(user_id)')
        
        # Migration: Add new columns if they don't exist
        try:
            cursor.execute("ALTER TABLE users ADD COLUMN last_login TEXT")
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
        print("✓ Database initialized successfully")

init_db()

def get_db_connection():
    """Get database connection with row factory"""
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

# ============================================
# SECURITY UTILITIES
# ============================================

def hash_password(password):
    """Hash password using PBKDF2"""
    return generate_password_hash(password, method='pbkdf2:sha256', salt_length=16)

def verify_password(password_hash, password):
    """Verify password against hash"""
    return check_password_hash(password_hash, password)

def sanitize_input(text, max_length=500):
    """Basic input sanitization"""
    if not text:
        return ""
    # Remove any null bytes
    text = text.replace('\x00', '')
    # Limit length
    text = text[:max_length]
    # Strip leading/trailing whitespace
    text = text.strip()
    return text

def validate_json(*required_fields):
    """Decorator to validate JSON input"""
    def decorator(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            if not request.is_json:
                return jsonify({'error': 'Content-Type must be application/json'}), 400
            
            data = request.json
            for field in required_fields:
                if field not in data or not data[field]:
                    return jsonify({'error': f'Missing required field: {field}'}), 400
            
            return f(*args, **kwargs)
        return wrapper
    return decorator

def require_admin(f):
    """Decorator to require admin authentication"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Check admin password from header
        admin_pass = request.headers.get('X-Admin-Password')
        if admin_pass != ADMIN_PASSWORD:
            return jsonify({'error': 'Admin authentication required'}), 403
        return f(*args, **kwargs)
    return decorated_function

# Apply rate limiting decorator conditionally
def rate_limit(limit_string):
    """Conditional rate limiting decorator"""
    def decorator(f):
        if limiter:
            return limiter.limit(limit_string)(f)
        return f
    return decorator

# ============================================
# STATIC FILE SERVING
# ============================================

@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)

# ============================================
# AUTHENTICATION ROUTES
# ============================================

@app.route('/api/auth/register', methods=['POST'])
@rate_limit("5 per hour")
@validate_json('username', 'email', 'password')
def register():
    """Register a new user"""
    data = request.json
    username = sanitize_input(data.get('username'), 50)
    email = sanitize_input(data.get('email'), 100).lower()
    password = data.get('password', '')
    
    # Validate username
    if len(username) < 3 or len(username) > 50:
        return jsonify({'error': 'Username must be 3-50 characters'}), 400
    
    # Validate email format
    if '@' not in email or '.' not in email.split('@')[1]:
        return jsonify({'error': 'Invalid email format'}), 400
    
    # Validate password strength
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
    
    try:
        conn.execute('''
            INSERT INTO users (id, username, email, password_hash, points, created_at, last_login)
            VALUES (?, ?, ?, ?, 0, ?, ?)
        ''', (user_id, username, email, password_hash, datetime.now().isoformat(), datetime.now().isoformat()))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({'error': 'Username or email already exists'}), 400
    finally:
        conn.close()
    
    return jsonify({
        'message': 'Registration successful',
        'user': {'id': user_id, 'username': username, 'email': email, 'points': 0}
    }), 201

@app.route('/api/auth/login', methods=['POST'])
@rate_limit("10 per hour")
@validate_json('email', 'password')
def login():
    """Login user"""
    data = request.json
    email = sanitize_input(data.get('email'), 100).lower()
    password = data.get('password', '')
    
    conn = get_db_connection()
    user = conn.execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()
    
    if not user or not verify_password(user['password_hash'], password):
        conn.close()
        return jsonify({'error': 'Invalid email or password'}), 401
    
    # Update last login
    conn.execute('UPDATE users SET last_login = ? WHERE id = ?', (datetime.now().isoformat(), user['id']))
    conn.commit()
    conn.close()
    
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
    """Get user details"""
    conn = get_db_connection()
    user = conn.execute('SELECT id, username, email, points, created_at FROM users WHERE id = ?', (user_id,)).fetchone()
    conn.close()
    
    if not user:
        return jsonify({'error': 'User not found'}), 404
    
    return jsonify(dict(user))

# ============================================
# LEADERBOARD
# ============================================

@app.route('/api/leaderboard', methods=['GET'])
def get_leaderboard():
    """Get top users by points"""
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

# ============================================
# REWARDS
# ============================================

@app.route('/api/rewards', methods=['GET'])
def get_rewards():
    """Get all available rewards"""
    conn = get_db_connection()
    rewards = conn.execute('SELECT * FROM rewards ORDER BY points_required').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rewards])

@app.route('/api/users/<user_id>/rewards', methods=['GET'])
def get_user_rewards(user_id):
    """Get user's earned rewards"""
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
@require_admin
def admin_give_reward():
    """Admin: Give reward to user"""
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

# ============================================
# ISSUES ROUTES
# ============================================

@app.route('/api/issues', methods=['GET'])
def get_issues():
    """Get all issues with pagination"""
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 50, type=int)
    per_page = min(per_page, 100)  # Max 100 per page
    offset = (page - 1) * per_page
    
    conn = get_db_connection()
    issues = conn.execute('''
        SELECT i.*, u.username as reporter_name 
        FROM issues i 
        LEFT JOIN users u ON i.user_id = u.id 
        ORDER BY date DESC
        LIMIT ? OFFSET ?
    ''', (per_page, offset)).fetchall()
    
    total = conn.execute('SELECT COUNT(*) FROM issues').fetchone()[0]
    conn.close()
    
    # Return simple list for backward compatibility
    return jsonify([dict(ix) for ix in issues])

@app.route('/api/issues', methods=['POST'])
@rate_limit("10 per hour")
def create_issue():
    """Create a new issue"""
    if not request.is_json:
        return jsonify({'error': 'Content-Type must be application/json'}), 400
    
    data = request.json
    
    # Validate required fields
    required = ['type', 'location', 'description']
    for field in required:
        if field not in data or not data[field]:
            return jsonify({'error': f'Missing required field: {field}'}), 400
    
    # Sanitize inputs
    issue_type = sanitize_input(data['type'], 100)
    location = sanitize_input(data['location'], 200)
    description = sanitize_input(data['description'], 1000)
    
    # Validate coordinates if provided
    lat = data.get('lat')
    lng = data.get('lng')
    if lat is not None and lng is not None:
        try:
            lat = float(lat)
            lng = float(lng)
            # Basic validation for India (rough bounds)
            if not (6 <= lat <= 37 and 68 <= lng <= 98):
                return jsonify({'error': 'Invalid coordinates'}), 400
        except (ValueError, TypeError):
            return jsonify({'error': 'Invalid coordinate format'}), 400
    
    # Validate image size (base64)
    image = data.get('image')
    if image:
        # Check if it's a valid base64 data URL
        if not image.startswith('data:image/'):
            return jsonify({'error': 'Invalid image format'}), 400
        # Check approximate size (base64 is ~33% larger than binary)
        if len(image) > 7000000:  # ~5MB in base64
            return jsonify({'error': 'Image too large (max 5MB)'}), 400
    
    issue_id = secrets.token_hex(8)
    
    new_issue = (
        issue_id,
        data.get('user_id'),
        issue_type,
        location,
        lat,
        lng,
        description,
        image,
        data.get('date', datetime.now().isoformat()),
        'pending',
        0
    )
    
    conn = get_db_connection()
    try:
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
        
        # Broadcast new issue to all clients
        socketio.emit('new_issue', dict(issue))
        
        return jsonify({'message': 'Issue reported successfully', 'id': issue_id}), 201
    except Exception as e:
        print(f"Error creating issue: {e}")
        return jsonify({'error': 'Failed to create issue'}), 500
    finally:
        conn.close()

@app.route('/api/issues/<id>/status', methods=['PUT'])
@require_admin
def update_status(id):
    """Update issue status (admin only)"""
    new_status = request.json.get('status')
    
    if new_status not in ['pending', 'in-progress', 'solved']:
        return jsonify({'error': 'Invalid status'}), 400
    
    conn = get_db_connection()
    issue = conn.execute('SELECT * FROM issues WHERE id = ?', (id,)).fetchone()
    
    if not issue:
        conn.close()
        return jsonify({'error': 'Issue not found'}), 404
    
    old_status = issue['status']
    points_to_award = 0
    
    # Award points based on status change
    if issue['user_id']:
        if old_status == 'pending' and new_status == 'in-progress':
            if issue['points_awarded'] == 0:
                points_to_award = 10
        elif new_status == 'solved' and issue['points_awarded'] < 30:
            points_to_award = 20
    
    total_points = issue['points_awarded'] + points_to_award
    conn.execute('UPDATE issues SET status = ?, points_awarded = ? WHERE id = ?', (new_status, total_points, id))
    
    if points_to_award > 0 and issue['user_id']:
        conn.execute('UPDATE users SET points = points + ? WHERE id = ?', (points_to_award, issue['user_id']))
        user = conn.execute('SELECT points FROM users WHERE id = ?', (issue['user_id'],)).fetchone()
        socketio.emit('points_updated', {'user_id': issue['user_id'], 'points': user['points'], 'added': points_to_award})
    
    conn.commit()
    conn.close()
    
    socketio.emit('status_updated', {'issue_id': id, 'status': new_status, 'points_awarded': points_to_award})
    
    return jsonify({'message': 'Status updated', 'points_awarded': points_to_award})

@app.route('/api/issues/<id>', methods=['DELETE'])
@require_admin
def delete_issue(id):
    """Delete issue (admin only)"""
    conn = get_db_connection()
    conn.execute('DELETE FROM issues WHERE id = ?', (id,))
    conn.commit()
    conn.close()
    
    socketio.emit('issue_deleted', {'issue_id': id})
    
    return jsonify({'message': 'Issue deleted'})

# ============================================
# ADMIN ROUTES
# ============================================

@app.route('/api/admin/users', methods=['GET'])
@require_admin
def get_all_users():
    """Get all users (admin only)"""
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
@require_admin
def get_stats():
    """Get admin statistics"""
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

# ============================================
# ERROR HANDLERS
# ============================================

@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({'error': 'Internal server error'}), 500

@app.errorhandler(429)
def ratelimit_handler(e):
    return jsonify({'error': 'Rate limit exceeded. Please try again later.'}), 429

# ============================================
# SOCKETIO EVENTS
# ============================================

@socketio.on('connect')
def handle_connect():
    print('Client connected')

@socketio.on('disconnect')
def handle_disconnect():
    print('Client disconnected')

# ============================================
# MAIN
# ============================================

if __name__ == '__main__':
    import socket
    hostname = socket.gethostname()
    try:
        local_ip = socket.gethostbyname(hostname)
        print(f"\n  ╔════════════════════════════════════════════════════════╗")
        print(f"  ║  🌐 CityFix Server Running!                            ║")
        print(f"  ╠════════════════════════════════════════════════════════╣")
        print(f"  ║  💻 Local:   http://localhost:5000                     ║")
        print(f"  ║  📱 Network: http://{local_ip}:5000{' ' * (19 - len(local_ip))}║")
        print(f"  ╠════════════════════════════════════════════════════════╣")
        print(f"  ║  🔐 Security Features:                                 ║")
        print(f"  ║   ✓ Password hashing with PBKDF2                      ║")
        print(f"  ║   {'✓' if limiter else '✗'} Rate limiting {'enabled' if limiter else 'disabled'}{' ' * (30 - len('enabled' if limiter else 'disabled'))}║")
        print(f"  ║   ✓ Input validation & sanitization                   ║")
        print(f"  ║   ✓ Admin authentication                              ║")
        print(f"  ╚════════════════════════════════════════════════════════╝\n")
    except:
        pass
    
    socketio.run(app, debug=True, host='0.0.0.0', port=5000, allow_unsafe_werkzeug=True)
