// ============================================
// CityFix - Local Problem Reporter
// ============================================

const API_URL = '/api';

// State Management
const STATE = {
    issues: [],
    users: [],
    rewards: [],
    currentUser: null,
    isAdmin: false,
    filter: 'all'
};

// Map Variables
let pickerMap = null;
let mainMap = null;
let pickerMarker = null;
let issueMarkers = [];

// Socket.IO Connection
let socket = null;

// India default coordinates
const INDIA_CENTER = [20.5937, 78.9629];

// ============================================
// INITIALIZATION
// ============================================

async function init() {
    // Load saved user session
    const savedUser = localStorage.getItem('cityfix_user');
    if (savedUser) {
        STATE.currentUser = JSON.parse(savedUser);
        updateUserUI();
    }

    // Initialize Socket.IO
    initSocket();

    // Fetch data
    await fetchIssues();
    await fetchLeaderboard();
    await fetchRewards();

    // Initialize maps
    initPickerMap();
    initMainMap();

    // Setup router
    router();

    // Setup event listeners
    setupEventListeners();
}

function initSocket() {
    socket = io();

    socket.on('connect', () => {
        console.log('🔌 Connected to server');
        showToast('Connected to live updates', 'success');
    });

    socket.on('disconnect', () => {
        console.log('❌ Disconnected from server');
    });

    socket.on('new_issue', (issue) => {
        STATE.issues.unshift(issue);
        renderHome();
        renderMainMap();
        showToast('New issue reported!', 'info');
    });

    socket.on('status_updated', (data) => {
        const issue = STATE.issues.find(i => i.id === data.issue_id);
        if (issue) {
            issue.status = data.status;
            renderHome();
            if (STATE.isAdmin) renderAdminTable();
        }
        if (data.points_awarded > 0) {
            showToast(`${data.points_awarded} points awarded!`, 'success');
        }
    });

    socket.on('issue_deleted', (data) => {
        STATE.issues = STATE.issues.filter(i => i.id !== data.issue_id);
        renderHome();
        renderMainMap();
    });

    socket.on('points_updated', (data) => {
        if (STATE.currentUser && STATE.currentUser.id === data.user_id) {
            STATE.currentUser.points = data.points;
            localStorage.setItem('cityfix_user', JSON.stringify(STATE.currentUser));
            updateUserUI();
            if (data.added) {
                showPointsAnimation(data.added);
            }
        }
        fetchLeaderboard();
    });
}

// ============================================
// DATA FETCHING
// ============================================

async function fetchIssues() {
    try {
        const res = await fetch(`${API_URL}/issues`);
        STATE.issues = await res.json();
        renderHome();
    } catch (e) {
        console.error('Error fetching issues:', e);
    }
}

async function fetchLeaderboard() {
    try {
        const res = await fetch(`${API_URL}/leaderboard`);
        STATE.users = await res.json();
        renderLeaderboard();
    } catch (e) {
        console.error('Error fetching leaderboard:', e);
    }
}

async function fetchRewards() {
    try {
        const res = await fetch(`${API_URL}/rewards`);
        STATE.rewards = await res.json();
        renderRewards();
    } catch (e) {
        console.error('Error fetching rewards:', e);
    }
}

async function fetchAdminStats() {
    try {
        const res = await fetch(`${API_URL}/admin/stats`);
        const stats = await res.json();
        document.getElementById('admin-total').textContent = stats.total_issues;
        document.getElementById('admin-pending').textContent = stats.pending;
        document.getElementById('admin-progress').textContent = stats.in_progress;
        document.getElementById('admin-solved').textContent = stats.solved;
    } catch (e) {
        console.error('Error fetching stats:', e);
    }
}

async function fetchAdminUsers() {
    try {
        const res = await fetch(`${API_URL}/admin/users`);
        const users = await res.json();
        renderAdminUsers(users);
    } catch (e) {
        console.error('Error fetching users:', e);
    }
}

// ============================================
// AUTHENTICATION
// ============================================

document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    try {
        const res = await fetch(`${API_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await res.json();

        if (res.ok) {
            STATE.currentUser = data.user;
            localStorage.setItem('cityfix_user', JSON.stringify(data.user));
            updateUserUI();
            hideModal('login');
            showToast(`Welcome back, ${data.user.username}!`, 'success');
        } else {
            showToast(data.error || 'Login failed', 'danger');
        }
    } catch (e) {
        showToast('Connection error', 'danger');
    }
});

document.getElementById('register-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('register-username').value;
    const email = document.getElementById('register-email').value;
    const password = document.getElementById('register-password').value;

    try {
        const res = await fetch(`${API_URL}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password })
        });

        const data = await res.json();

        if (res.ok) {
            STATE.currentUser = data.user;
            localStorage.setItem('cityfix_user', JSON.stringify(data.user));
            updateUserUI();
            hideModal('register');
            showToast(`Welcome to CityFix, ${data.user.username}!`, 'success');
        } else {
            showToast(data.error || 'Registration failed', 'danger');
        }
    } catch (e) {
        showToast('Connection error', 'danger');
    }
});

function logout() {
    STATE.currentUser = null;
    localStorage.removeItem('cityfix_user');
    updateUserUI();
    showToast('Logged out successfully', 'info');
    toggleProfileMenu();
}

function updateUserUI() {
    const guestActions = document.getElementById('guest-actions');
    const userProfile = document.getElementById('user-profile');
    const loginPrompt = document.getElementById('login-prompt');

    if (STATE.currentUser) {
        guestActions.classList.add('hidden');
        userProfile.classList.remove('hidden');
        document.getElementById('user-name').textContent = STATE.currentUser.username;
        document.getElementById('user-points').textContent = STATE.currentUser.points;
        document.getElementById('user-avatar').textContent = STATE.currentUser.username.charAt(0).toUpperCase();
        if (loginPrompt) loginPrompt.classList.add('hidden');
    } else {
        guestActions.classList.remove('hidden');
        userProfile.classList.add('hidden');
        if (loginPrompt) loginPrompt.classList.remove('hidden');
    }
}

// ============================================
// MODALS
// ============================================

function showModal(type) {
    document.getElementById(`${type}-modal`).classList.add('active');
    document.body.style.overflow = 'hidden';
}

function hideModal(type) {
    document.getElementById(`${type}-modal`).classList.remove('active');
    document.body.style.overflow = '';
}

function switchModal(type) {
    hideModal(type === 'login' ? 'register' : 'login');
    setTimeout(() => showModal(type), 200);
}

function toggleProfileMenu() {
    document.getElementById('profile-menu').classList.toggle('active');
}

async function showMyRewards() {
    toggleProfileMenu();
    if (!STATE.currentUser) return;

    try {
        const res = await fetch(`${API_URL}/users/${STATE.currentUser.id}/rewards`);
        const rewards = await res.json();

        const container = document.getElementById('my-rewards-list');
        if (rewards.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="ri-gift-line"></i>
                    <p>No rewards yet. Keep reporting to earn points!</p>
                </div>
            `;
        } else {
            container.innerHTML = rewards.map(r => `
                <div class="reward-item earned">
                    <span class="reward-icon">${r.icon}</span>
                    <div>
                        <h4>${r.name}</h4>
                        <p>${r.description}</p>
                        <small>Earned on ${formatDate(r.redeemed_at)}</small>
                    </div>
                </div>
            `).join('');
        }

        showModal('rewards');
    } catch (e) {
        console.error(e);
    }
}

// Close modals on outside click
document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            const type = modal.id.replace('-modal', '');
            hideModal(type);
        }
    });
});

// ============================================
// ROUTING
// ============================================

const router = () => {
    const hash = window.location.hash || '#home';
    const target = hash.substring(1);

    // Update Nav
    document.querySelectorAll('.nav-link, .mobile-nav-link').forEach(link => {
        const linkTarget = link.getAttribute('data-target');
        link.classList.toggle('active', linkTarget === target);
    });

    // Update Views
    document.querySelectorAll('.view').forEach(section => {
        section.classList.remove('active');
        if (section.id === `${target}-view`) {
            section.classList.add('active');
        }
    });

    // View-specific logic
    if (target === 'home') fetchIssues();
    if (target === 'map' && mainMap) {
        setTimeout(() => mainMap.invalidateSize(), 200);
        renderMainMap();
    }
    if (target === 'report' && pickerMap) {
        setTimeout(() => pickerMap.invalidateSize(), 200);
    }
    if (target === 'admin') renderAdmin();
    if (target === 'leaderboard') {
        fetchLeaderboard();
        fetchRewards();
    }
};

window.addEventListener('hashchange', router);
window.addEventListener('load', init);

// ============================================
// MAP LOGIC
// ============================================

function initPickerMap() {
    pickerMap = L.map('map-picker').setView(INDIA_CENTER, 5);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(pickerMap);

    // Click to pin
    pickerMap.on('click', function (e) {
        const lat = e.latlng.lat;
        const lng = e.latlng.lng;

        if (pickerMarker) pickerMap.removeLayer(pickerMarker);
        pickerMarker = L.marker([lat, lng]).addTo(pickerMap);

        document.getElementById('issue-lat').value = lat;
        document.getElementById('issue-lng').value = lng;

        // Reverse Geocode
        fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`)
            .then(res => res.json())
            .then(data => {
                const address = data.display_name.split(',').slice(0, 3).join(', ');
                document.getElementById('issue-location').value = address;
            })
            .catch(() => {
                document.getElementById('issue-location').value = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
            });
    });

    // Try GeoLocation
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            const { latitude, longitude } = pos.coords;
            pickerMap.setView([latitude, longitude], 14);
        }, () => {
            // Keep India center if denied
        });
    }

    // Initialize location autocomplete
    initLocationAutocomplete();
}

// ============================================
// LOCATION AUTOCOMPLETE
// ============================================

let searchTimeout = null;

function initLocationAutocomplete() {
    const searchInput = document.getElementById('location-search');
    const suggestionsContainer = document.getElementById('location-suggestions');
    const loadingIndicator = document.getElementById('search-loading');

    if (!searchInput) return;

    // Search on input
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();

        // Clear previous timeout
        if (searchTimeout) clearTimeout(searchTimeout);

        // Hide suggestions if query is too short
        if (query.length < 3) {
            suggestionsContainer.classList.add('hidden');
            return;
        }

        // Debounce: wait 400ms before searching
        searchTimeout = setTimeout(() => {
            searchLocation(query);
        }, 400);
    });

    // Hide suggestions when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.location-autocomplete')) {
            suggestionsContainer.classList.add('hidden');
        }
    });

    // Handle keyboard navigation
    searchInput.addEventListener('keydown', (e) => {
        const items = suggestionsContainer.querySelectorAll('.suggestion-item');
        const active = suggestionsContainer.querySelector('.suggestion-item.active');
        let index = Array.from(items).indexOf(active);

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (index < items.length - 1) index++;
            else index = 0;
            items.forEach(i => i.classList.remove('active'));
            items[index]?.classList.add('active');
            items[index]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (index > 0) index--;
            else index = items.length - 1;
            items.forEach(i => i.classList.remove('active'));
            items[index]?.classList.add('active');
            items[index]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (active) {
                active.click();
            }
        } else if (e.key === 'Escape') {
            suggestionsContainer.classList.add('hidden');
        }
    });
}

async function searchLocation(query) {
    const suggestionsContainer = document.getElementById('location-suggestions');
    const loadingIndicator = document.getElementById('search-loading');

    loadingIndicator.classList.remove('hidden');

    try {
        // Search using Nominatim (OpenStreetMap) - focus on India
        const response = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=in&limit=8&addressdetails=1`
        );

        const results = await response.json();

        loadingIndicator.classList.add('hidden');

        if (results.length === 0) {
            suggestionsContainer.innerHTML = `
                <div class="no-results">
                    <i class="ri-map-pin-line"></i>
                    <p>No places found. Try a different search.</p>
                </div>
            `;
            suggestionsContainer.classList.remove('hidden');
            return;
        }

        // Render suggestions
        suggestionsContainer.innerHTML = results.map((place, idx) => {
            const name = place.display_name.split(',').slice(0, 3).join(', ');
            const type = place.type.replace(/_/g, ' ');

            return `
                <div class="suggestion-item ${idx === 0 ? 'active' : ''}" 
                     data-lat="${place.lat}" 
                     data-lng="${place.lon}"
                     data-name="${place.display_name}">
                    <i class="ri-map-pin-2-fill"></i>
                    <div class="suggestion-text">
                        <span class="suggestion-name">${name}</span>
                        <span class="suggestion-type">${type}</span>
                    </div>
                </div>
            `;
        }).join('');

        suggestionsContainer.classList.remove('hidden');

        // Add click handlers
        suggestionsContainer.querySelectorAll('.suggestion-item').forEach(item => {
            item.addEventListener('click', () => selectLocation(item));
        });

    } catch (error) {
        console.error('Search error:', error);
        loadingIndicator.classList.add('hidden');
        suggestionsContainer.innerHTML = `
            <div class="no-results">
                <i class="ri-error-warning-line"></i>
                <p>Search failed. Please try again.</p>
            </div>
        `;
        suggestionsContainer.classList.remove('hidden');
    }
}

function selectLocation(item) {
    const lat = parseFloat(item.dataset.lat);
    const lng = parseFloat(item.dataset.lng);
    const name = item.dataset.name.split(',').slice(0, 3).join(', ');

    // Update form fields
    document.getElementById('issue-lat').value = lat;
    document.getElementById('issue-lng').value = lng;
    document.getElementById('issue-location').value = name;
    document.getElementById('location-search').value = '';

    // Hide suggestions
    document.getElementById('location-suggestions').classList.add('hidden');

    // Update map
    if (pickerMap) {
        pickerMap.setView([lat, lng], 16);

        if (pickerMarker) pickerMap.removeLayer(pickerMarker);
        pickerMarker = L.marker([lat, lng]).addTo(pickerMap);
    }

    showToast('Location selected!', 'success');
}

function initMainMap() {
    mainMap = L.map('main-map').setView(INDIA_CENTER, 5);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(mainMap);

    renderMainMap();
}

function renderMainMap() {
    if (!mainMap) return;

    // Clear existing markers
    issueMarkers.forEach(m => mainMap.removeLayer(m));
    issueMarkers = [];

    // Add issue markers
    STATE.issues.forEach(issue => {
        if (issue.lat && issue.lng) {
            const color = issue.status === 'solved' ? 'green' :
                issue.status === 'in-progress' ? 'blue' : 'red';

            const icon = L.divIcon({
                className: 'custom-marker',
                html: `<div class="marker-pin ${color}"><i class="ri-map-pin-fill"></i></div>`,
                iconSize: [30, 42],
                iconAnchor: [15, 42]
            });

            const marker = L.marker([issue.lat, issue.lng], { icon }).addTo(mainMap);
            marker.bindPopup(`
                <div class="map-popup">
                    <strong>${issue.type}</strong>
                    <p>${issue.location}</p>
                    <span class="status-badge status-${issue.status.replace(' ', '-')}">${issue.status}</span>
                </div>
            `);
            issueMarkers.push(marker);
        }
    });

    // Fit bounds if we have markers
    if (issueMarkers.length > 0) {
        const group = L.featureGroup(issueMarkers);
        mainMap.fitBounds(group.getBounds().pad(0.1));
    }
}

// ============================================
// HOME / FEED RENDERING
// ============================================

function renderHome() {
    // Stats
    document.getElementById('total-issues').textContent = STATE.issues.length;
    document.getElementById('progress-issues').textContent = STATE.issues.filter(i => i.status === 'in-progress').length;
    document.getElementById('solved-issues').textContent = STATE.issues.filter(i => i.status === 'solved').length;

    // Filter Logic
    const filteredIssues = STATE.filter === 'all'
        ? STATE.issues
        : STATE.issues.filter(i => i.status === STATE.filter);

    // Render Grid
    const feed = document.getElementById('issue-feed');
    feed.innerHTML = filteredIssues.length ? filteredIssues.map(issue => `
        <div class="issue-card" onclick="viewIssue('${issue.id}')">
            <div class="card-img" style="background: url('${issue.image || 'https://images.unsplash.com/photo-1598228723793-52759bba239c?q=80&w=400&auto=format&fit=crop'}') center/cover no-repeat;"></div>
            <div class="card-body">
                <span class="status-badge status-${issue.status.replace(' ', '-')}">${issue.status}</span>
                <h3 class="card-title">${issue.type}</h3>
                <div class="card-info">
                    <i class="ri-map-pin-line"></i> ${issue.location}
                </div>
                ${issue.lat ? `
                    <div class="card-info">
                        <a href="https://www.google.com/maps?q=${issue.lat},${issue.lng}" target="_blank" class="map-link">
                            <i class="ri-external-link-line"></i> View on Google Maps
                        </a>
                    </div>
                ` : ''}
                <div class="card-info">
                    <i class="ri-calendar-line"></i> ${formatDate(issue.date)}
                </div>
                ${issue.reporter_name ? `
                    <div class="card-info">
                        <i class="ri-user-line"></i> Reported by ${issue.reporter_name}
                    </div>
                ` : ''}
                <p class="card-desc">${issue.description}</p>
            </div>
        </div>
    `).join('') : '<p class="empty-message">No issues found matching criteria.</p>';
}

function viewIssue(id) {
    const issue = STATE.issues.find(i => i.id === id);
    if (issue && issue.lat) {
        window.location.hash = '#map';
        setTimeout(() => {
            mainMap.setView([issue.lat, issue.lng], 16);
            const marker = issueMarkers.find(m =>
                m.getLatLng().lat === issue.lat && m.getLatLng().lng === issue.lng
            );
            if (marker) marker.openPopup();
        }, 300);
    }
}

// Filter Listeners
document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        STATE.filter = btn.dataset.filter;
        renderHome();
    });
});

// ============================================
// REPORT FORM
// ============================================

let currentImageBase64 = null;
const imageInput = document.getElementById('issue-image');
const fileNameDisplay = document.getElementById('file-name-display');
const imagePreview = document.getElementById('image-preview');

imageInput?.addEventListener('change', function () {
    if (this.files && this.files[0]) {
        const file = this.files[0];
        fileNameDisplay.textContent = file.name;

        const reader = new FileReader();
        reader.onload = (e) => {
            currentImageBase64 = e.target.result;
            imagePreview.innerHTML = `<img src="${currentImageBase64}" alt="Preview">`;
            imagePreview.classList.remove('hidden');
        };
        reader.readAsDataURL(file);
    }
});

document.getElementById('report-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const lat = document.getElementById('issue-lat').value;
    const lng = document.getElementById('issue-lng').value;

    if (!lat || !lng) {
        showToast('Please click on the map to select a location', 'warning');
        return;
    }

    const newIssue = {
        user_id: STATE.currentUser?.id || null,
        type: document.getElementById('issue-type').value,
        location: document.getElementById('issue-location').value,
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        description: document.getElementById('issue-desc').value,
        image: currentImageBase64,
        date: new Date().toISOString()
    };

    try {
        const res = await fetch(`${API_URL}/issues`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newIssue)
        });

        if (res.ok) {
            showToast('Issue reported successfully!', 'success');
            document.getElementById('report-form').reset();
            currentImageBase64 = null;
            if (pickerMarker) {
                pickerMap.removeLayer(pickerMarker);
                pickerMarker = null;
            }
            fileNameDisplay.textContent = 'No file selected';
            imagePreview.classList.add('hidden');
            imagePreview.innerHTML = '';

            if (!STATE.currentUser) {
                showToast('Login to earn points for your reports!', 'info');
            }

            setTimeout(() => window.location.hash = '#home', 1000);
        } else {
            showToast('Failed to submit report', 'danger');
        }
    } catch (err) {
        showToast('Server error', 'danger');
        console.error(err);
    }
});

// ============================================
// LEADERBOARD
// ============================================

function renderLeaderboard() {
    const container = document.getElementById('leaderboard-list');
    if (!container) return;

    container.innerHTML = STATE.users.map((user, index) => {
        const rank = index + 1;
        const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
        const isMe = STATE.currentUser && STATE.currentUser.id === user.id;

        return `
            <div class="leaderboard-item ${isMe ? 'is-me' : ''} ${rank <= 3 ? 'top-3' : ''}">
                <div class="rank">${medal || rank}</div>
                <div class="avatar">${user.username.charAt(0).toUpperCase()}</div>
                <div class="user-info">
                    <h4>${user.username} ${isMe ? '(You)' : ''}</h4>
                    <p>${user.total_reports} reports · ${user.solved_reports} solved</p>
                </div>
                <div class="points">
                    <i class="ri-coin-fill"></i>
                    <span>${user.points}</span>
                </div>
            </div>
        `;
    }).join('') || '<p class="empty-message">No reporters yet. Be the first!</p>';
}

function renderRewards() {
    const container = document.getElementById('rewards-list');
    if (!container) return;

    container.innerHTML = STATE.rewards.map(reward => `
        <div class="reward-card">
            <span class="reward-icon">${reward.icon}</span>
            <h4>${reward.name}</h4>
            <p>${reward.description}</p>
            <div class="reward-points">
                <i class="ri-coin-fill"></i> ${reward.points_required} pts
            </div>
        </div>
    `).join('');
}

// ============================================
// ADMIN
// ============================================

const adminAuth = document.getElementById('admin-auth');
const adminDash = document.getElementById('admin-dashboard');
const adminForm = document.getElementById('admin-login-form');

function renderAdmin() {
    if (!STATE.isAdmin) {
        adminAuth?.classList.remove('hidden');
        adminDash?.classList.add('hidden');
    } else {
        adminAuth?.classList.add('hidden');
        adminDash?.classList.remove('hidden');
        fetchAdminStats();
        renderAdminTable();
        fetchAdminUsers();
        populateRewardSelects();
    }
}

adminForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const pw = document.getElementById('admin-password').value;
    if (pw === 'admin123') {
        STATE.isAdmin = true;
        renderAdmin();
        showToast('Welcome, Admin!', 'success');
    } else {
        showToast('Incorrect password', 'danger');
    }
});

document.getElementById('admin-logout')?.addEventListener('click', () => {
    STATE.isAdmin = false;
    renderAdmin();
});

// Admin Tabs
document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));

        tab.classList.add('active');
        const tabName = tab.dataset.tab;
        document.getElementById(`admin-${tabName}-tab`).classList.add('active');

        if (tabName === 'users') fetchAdminUsers();
    });
});

function renderAdminTable() {
    const tbody = document.getElementById('admin-issues-list');
    if (!tbody) return;

    tbody.innerHTML = STATE.issues.map(issue => `
        <tr>
            <td><small class="id-badge">${issue.id.substr(0, 6)}</small></td>
            <td>${issue.type}</td>
            <td>${issue.location}</td>
            <td>${issue.reporter_name || 'Anonymous'}</td>
            <td>${formatDate(issue.date)}</td>
            <td><span class="status-badge status-${issue.status.replace(' ', '-')}">${issue.status}</span></td>
            <td>${issue.points_awarded || 0} pts</td>
            <td class="actions">
                <button class="action-btn" onclick="updateStatus('${issue.id}', 'pending')" title="Pending">
                    <i class="ri-time-line"></i>
                </button>
                <button class="action-btn accent" onclick="updateStatus('${issue.id}', 'in-progress')" title="In Progress (+10 pts)">
                    <i class="ri-tools-line"></i>
                </button>
                <button class="action-btn success" onclick="updateStatus('${issue.id}', 'solved')" title="Solved (+20 pts)">
                    <i class="ri-checkbox-circle-line"></i>
                </button>
                <button class="action-btn danger" onclick="deleteIssue('${issue.id}')" title="Delete">
                    <i class="ri-delete-bin-line"></i>
                </button>
            </td>
        </tr>
    `).join('') || '<tr><td colspan="8" class="empty-message">No issues reported yet.</td></tr>';
}

function renderAdminUsers(users) {
    const tbody = document.getElementById('admin-users-list');
    if (!tbody) return;

    tbody.innerHTML = users.map(user => `
        <tr>
            <td><strong>${user.username}</strong></td>
            <td>${user.email}</td>
            <td><span class="points-badge"><i class="ri-coin-fill"></i> ${user.points}</span></td>
            <td>${user.total_reports}</td>
            <td>${formatDate(user.created_at)}</td>
        </tr>
    `).join('') || '<tr><td colspan="5" class="empty-message">No users registered yet.</td></tr>';
}

async function populateRewardSelects() {
    // Populate user select
    const userSelect = document.getElementById('reward-user-select');
    const users = await (await fetch(`${API_URL}/admin/users`)).json();
    userSelect.innerHTML = '<option value="">Select a user...</option>' +
        users.map(u => `<option value="${u.id}">${u.username} (${u.points} pts)</option>`).join('');

    // Populate reward select
    const rewardSelect = document.getElementById('reward-select');
    rewardSelect.innerHTML = '<option value="">Select a reward...</option>' +
        STATE.rewards.map(r => `<option value="${r.id}">${r.icon} ${r.name} (${r.points_required} pts)</option>`).join('');
}

async function giveReward() {
    const userId = document.getElementById('reward-user-select').value;
    const rewardId = document.getElementById('reward-select').value;

    if (!userId || !rewardId) {
        showToast('Please select a user and reward', 'warning');
        return;
    }

    try {
        const res = await fetch(`${API_URL}/admin/give-reward`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, reward_id: rewardId })
        });

        const data = await res.json();

        if (res.ok) {
            showToast('Reward given successfully!', 'success');
            populateRewardSelects();
            fetchAdminUsers();
        } else {
            showToast(data.error || 'Failed to give reward', 'danger');
        }
    } catch (e) {
        showToast('Server error', 'danger');
    }
}

// Admin Actions
window.updateStatus = async (id, status) => {
    try {
        await fetch(`${API_URL}/issues/${id}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
        showToast(`Status updated to ${status}`, 'success');
        fetchIssues().then(() => {
            renderAdminTable();
            fetchAdminStats();
        });
    } catch (e) {
        console.error(e);
        showToast('Failed to update', 'danger');
    }
};

window.deleteIssue = async (id) => {
    if (confirm('Are you sure you want to delete this report?')) {
        try {
            await fetch(`${API_URL}/issues/${id}`, { method: 'DELETE' });
            showToast('Report deleted', 'success');
            fetchIssues().then(() => {
                renderAdminTable();
                fetchAdminStats();
            });
        } catch (e) {
            showToast('Failed to delete', 'danger');
        }
    }
};

// ============================================
// UTILITIES
// ============================================

const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString('en-IN', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });
};

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icon = type === 'success' ? 'checkbox-circle' :
        type === 'danger' ? 'error-warning' :
            type === 'warning' ? 'alert' : 'information';

    toast.innerHTML = `
        <i class="ri-${icon}-fill"></i>
        <span>${message}</span>
    `;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function showPointsAnimation(points) {
    const popup = document.getElementById('points-popup');
    const valueEl = document.getElementById('points-value');
    valueEl.textContent = points;
    popup.classList.remove('hidden');
    popup.classList.add('animate');

    setTimeout(() => {
        popup.classList.add('hidden');
        popup.classList.remove('animate');
    }, 2000);
}

function setupEventListeners() {
    // Close profile menu when clicking outside
    document.addEventListener('click', (e) => {
        const profileMenu = document.getElementById('profile-menu');
        const profileBtn = document.querySelector('.profile-btn');

        if (profileMenu && !profileMenu.contains(e.target) && !profileBtn?.contains(e.target)) {
            profileMenu.classList.remove('active');
        }
    });
}

// Make functions globally available
window.showModal = showModal;
window.hideModal = hideModal;
window.switchModal = switchModal;
window.toggleProfileMenu = toggleProfileMenu;
window.logout = logout;
window.showMyRewards = showMyRewards;
window.giveReward = giveReward;
window.viewIssue = viewIssue;
