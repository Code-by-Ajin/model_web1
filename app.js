// Config - Change to actual IP if needed, but relative path works if served by Flask
const API_URL = '/api/issues';

// State Management
const STATE = {
    issues: [], // Now populated from API
    isAdmin: false,
    filter: 'all'
};

// Map Variables
let map = null;
let marker = null;

// Utils
const formatDate = (dateString) => new Date(dateString).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

// DOM Elements
const sections = document.querySelectorAll('.view');
const navLinks = document.querySelectorAll('.nav-link');
const issueFeed = document.getElementById('issue-feed');
const totalIssuesEl = document.getElementById('total-issues');
const solvedIssuesEl = document.getElementById('solved-issues');
const reportForm = document.getElementById('report-form');
const filterBtns = document.querySelectorAll('.filter-btn');

// --- INITIALIZATION ---

async function init() {
    await fetchIssues();
    initMap();
    router();
}

async function fetchIssues() {
    try {
        const res = await fetch(API_URL);
        STATE.issues = await res.json();
        renderHome();
    } catch (e) {
        showToast('Error connecting to server', 'danger');
        console.error(e);
    }
}

// Router
const router = () => {
    const hash = window.location.hash || '#home';
    const target = hash.substring(1);

    // Update Nav
    navLinks.forEach(link => {
        link.classList.toggle('active', link.getAttribute('href') === hash);
    });

    // Update Views
    sections.forEach(section => {
        section.classList.remove('active');
        if (section.id === `${target}-view`) {
            section.classList.add('active');
        }
    });

    // Refresh Data based on view
    if (target === 'home') fetchIssues(); // Validate fresh data
    if (target === 'admin') renderAdmin();

    // Fix map rendering issues when unhidden
    if (target === 'report' && map) {
        setTimeout(() => map.invalidateSize(), 200);
    }
};

window.addEventListener('hashchange', router);
window.addEventListener('load', init);

// Notifications
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
        <i class="ri-${type === 'success' ? 'checkbox-circle' : 'information'}-fill" style="color: var(--${type})"></i>
        <span>${message}</span>
    `;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// --- MAP LOGIC ---

function initMap() {
    // Default: New York (or any city). We'll try to get user location.
    const defaultCoords = [40.7128, -74.0060];

    map = L.map('map-picker').setView(defaultCoords, 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    // Click to pin
    map.on('click', function (e) {
        const lat = e.latlng.lat;
        const lng = e.latlng.lng;

        if (marker) map.removeLayer(marker);
        marker = L.marker([lat, lng]).addTo(map);

        document.getElementById('issue-lat').value = lat;
        document.getElementById('issue-lng').value = lng;

        // Reverse Geocode (Optional polish)
        fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`)
            .then(res => res.json())
            .then(data => {
                document.getElementById('issue-location').value = data.display_name.split(',')[0];
            })
            .catch(() => {
                document.getElementById('issue-location').value = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
            });
    });

    // Try GeoLocation
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            const { latitude, longitude } = pos.coords;
            map.setView([latitude, longitude], 15);
        });
    }
}

// --- HOME / FEED LOGIC ---

function renderHome() {
    // Stats
    totalIssuesEl.textContent = STATE.issues.length;
    solvedIssuesEl.textContent = STATE.issues.filter(i => i.status === 'solved').length;

    // Filter Logic
    const filteredIssues = STATE.filter === 'all'
        ? STATE.issues
        : STATE.issues.filter(i => i.status === STATE.filter);

    // Render Grid
    issueFeed.innerHTML = filteredIssues.map(issue => `
        <div class="issue-card">
            <div class="card-img" style="background: url('${issue.image || 'https://images.unsplash.com/photo-1598228723793-52759bba239c?q=80&w=2574&auto=format&fit=crop'}') center/cover no-repeat;"></div>
            <div class="card-body">
                <span class="status-badge status-${issue.status.replace(' ', '-')}">${issue.status}</span>
                <h3 class="card-title">${issue.type}</h3>
                <div class="card-info">
                    <i class="ri-map-pin-line"></i> ${issue.location} 
                    ${issue.lat ? `<a href="https://www.google.com/maps?q=${issue.lat},${issue.lng}" target="_blank" style="color:var(--primary); font-size:0.8em; margin-left:5px;"><i class="ri-external-link-line"></i> View Map</a>` : ''}
                </div>
                <div class="card-info">
                    <i class="ri-calendar-line"></i> ${formatDate(issue.date)}
                </div>
                <p class="card-desc">${issue.description}</p>
            </div>
        </div>
    `).join('') || '<p style="text-align:center; grid-column: 1/-1; color: var(--text-muted);">No issues found matching criteria.</p>';
}

// Filter Listeners
filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        STATE.filter = btn.dataset.filter;
        renderHome();
    });
});

// --- REPORT LOGIC ---

// Image Preview / Base64 conversion
let currentImageBase64 = null;
const imageInput = document.getElementById('issue-image');
const fileNameDisplay = document.getElementById('file-name-display');

imageInput.addEventListener('change', function () {
    if (this.files && this.files[0]) {
        const file = this.files[0];
        fileNameDisplay.textContent = file.name;

        const reader = new FileReader();
        reader.onload = (e) => currentImageBase64 = e.target.result;
        reader.readAsDataURL(file);
    }
});

// Form Submit
reportForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const newIssue = {
        type: document.getElementById('issue-type').value,
        location: document.getElementById('issue-location').value,
        lat: document.getElementById('issue-lat').value,
        lng: document.getElementById('issue-lng').value,
        description: document.getElementById('issue-desc').value,
        image: currentImageBase64,
        date: new Date().toISOString()
    };

    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newIssue)
        });

        if (res.ok) {
            showToast('Issue reported successfully!', 'success');
            reportForm.reset();
            currentImageBase64 = null;
            marker = null;
            fileNameDisplay.textContent = "No file selected";
            setTimeout(() => window.location.hash = '#home', 1000);
        } else {
            showToast('Failed to submit report', 'danger');
        }
    } catch (err) {
        showToast('Server error', 'danger');
        console.error(err);
    }
});

// --- ADMIN LOGIC ---

const adminAuth = document.getElementById('admin-auth');
const adminDash = document.getElementById('admin-dashboard');
const adminForm = document.getElementById('admin-login-form');

function renderAdmin() {
    if (!STATE.isAdmin) {
        adminAuth.classList.remove('hidden');
        adminDash.classList.add('hidden');
    } else {
        adminAuth.classList.add('hidden');
        adminDash.classList.remove('hidden');
        renderAdminTable();
        // Since we fetch fresh data on navigation, admin table is up to date
    }
}

adminForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pw = document.getElementById('admin-password').value;
    if (pw === 'admin123') {
        STATE.isAdmin = true;
        renderAdmin();
        showToast('Welcome back, Admin', 'success');
    } else {
        showToast('Incorrect password', 'danger');
    }
});

document.getElementById('admin-logout').addEventListener('click', () => {
    STATE.isAdmin = false;
    renderAdmin();
});

function renderAdminTable() {
    const tbody = document.getElementById('admin-issues-list');
    tbody.innerHTML = STATE.issues.map(issue => `
        <tr>
            <td><small style="color:var(--text-muted)">${issue.id.substr(0, 6)}</small></td>
            <td>${issue.type}</td>
            <td>${issue.location}</td>
            <td>${formatDate(issue.date)}</td>
            <td><span class="status-badge status-${issue.status.replace(' ', '-')}">${issue.status}</span></td>
            <td>
                <button class="action-btn" onclick="updateStatus('${issue.id}', 'pending')" title="Mark Pending"><i class="ri-time-line"></i></button>
                <button class="action-btn" onclick="updateStatus('${issue.id}', 'in-progress')" title="Mark In Progress"><i class="ri-hammer-fill"></i></button>
                <button class="action-btn" onclick="updateStatus('${issue.id}', 'solved')" title="Mark Solved"><i class="ri-checkbox-circle-fill"></i></button>
                <button class="action-btn" style="color:var(--danger); border-color:var(--danger)" onclick="deleteIssue('${issue.id}')"><i class="ri-delete-bin-line"></i></button>
            </td>
        </tr>
    `).join('');
}

// API Calls for Actions
window.updateStatus = async (id, status) => {
    try {
        await fetch(`${API_URL}/${id}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
        showToast(`Status updated to ${status}`, 'success');
        fetchIssues().then(renderAdminTable); // Refresh
    } catch (e) {
        console.error(e);
        showToast('Failed to update', 'danger');
    }
};

window.deleteIssue = async (id) => {
    if (confirm('Are you sure you want to delete this report?')) {
        try {
            await fetch(`${API_URL}/${id}`, { method: 'DELETE' });
            showToast('Report deleted', 'success');
            fetchIssues().then(renderAdminTable); // Refresh
        } catch (e) {
            showToast('Failed to delete', 'danger');
        }
    }
};
