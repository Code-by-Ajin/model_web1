import sqlite3
import os
import secrets
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder='.')
CORS(app)  # Enable Cross-Origin Resource Sharing

DB_FILE = 'database.db'

def init_db():
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS issues (
                id TEXT PRIMARY KEY,
                type TEXT,
                location TEXT,
                lat REFERENCES,
                lng REAL,
                description TEXT,
                image TEXT,
                date TEXT,
                status TEXT
            )
        ''')
        # Check if lat/lng columns exist (migration for existing dev), if not add them
        # Simplified: just creating table if not exists. 
        # For a hackathon/proto style, we can just try/except adding columns or start fresh.
        try:
            cursor.execute("ALTER TABLE issues ADD COLUMN lat REAL")
            cursor.execute("ALTER TABLE issues ADD COLUMN lng REAL")
        except sqlite3.OperationalError:
            pass # Columns likely exist
        conn.commit()

# Initialize Database on Start
init_db()

def get_db_connection():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

# --- Routes ---

# Serve Frontend
@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)

# API Endpoints
@app.route('/api/issues', methods=['GET'])
def get_issues():
    conn = get_db_connection()
    issues = conn.execute('SELECT * FROM issues ORDER BY date DESC').fetchall()
    conn.close()
    return jsonify([dict(ix) for ix in issues])

@app.route('/api/issues', methods=['POST'])
def create_issue():
    data = request.json
    new_issue = (
        data.get('id', secrets.token_hex(8)),
        data['type'],
        data['location'],
        data.get('lat'), # Optional if map not used, though we should enforce it? Nah.
        data.get('lng'),
        data['description'],
        data.get('image'),
        data['date'],
        'pending'
    )
    
    conn = get_db_connection()
    conn.execute('''
        INSERT INTO issues (id, type, location, lat, lng, description, image, date, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', new_issue)
    conn.commit()
    conn.close()
    return jsonify({'message': 'Issue reported successfully', 'id': new_issue[0]}), 201

@app.route('/api/issues/<id>/status', methods=['PUT'])
def update_status(id):
    status = request.json.get('status')
    conn = get_db_connection()
    conn.execute('UPDATE issues SET status = ? WHERE id = ?', (status, id))
    conn.commit()
    conn.close()
    return jsonify({'message': 'Status updated'})

@app.route('/api/issues/<id>', methods=['DELETE'])
def delete_issue(id):
    conn = get_db_connection()
    conn.execute('DELETE FROM issues WHERE id = ?', (id,))
    conn.commit()
    conn.close()
    return jsonify({'message': 'Issue deleted'})

if __name__ == '__main__':
    # host='0.0.0.0' allows access from other devices on the network
    import socket
    hostname = socket.gethostname()
    try:
        local_ip = socket.gethostbyname(hostname)
        print(f" \n  To access from your phone, connect to same WiFi and visit: http://{local_ip}:5000 \n")
    except:
        pass
    app.run(debug=True, host='0.0.0.0', port=5000)
