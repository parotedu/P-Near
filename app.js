/**
 * P-Near: Serverless Real-Time Location Sharing Platform
 * Client-side core logic and MQTT/Leaflet integration.
 */

// Broker Configurations with WebSockets SSL ports
const BROKERS = [
    { name: "Eclipse Projects", url: "wss://mqtt.eclipseprojects.io:443/mqtt" },
    { name: "HiveMQ Public", url: "wss://broker.hivemq.com:8884/mqtt" },
    { name: "EMQX Public", url: "wss://broker.emqx.io:8084/mqtt" },
    { name: "Mosquitto Public", url: "wss://test.mosquitto.org:8081/mqtt" }
];

// Map Configurations
const MAP_THEMES = {
    dark: {
        url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    },
    light: {
        url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }
};

// Global App State
let state = {
    theme: 'dark',
    mode: 'dashboard', // 'dashboard', 'sharing', 'viewer'
    usingHighAccuracy: true, // track accuracy preference
    connectionAttempts: 0, // track consecutive connection failures
    // Sharer specific state
    activeShare: null, // { cID, key, name, exp, duration }
    watchId: null,
    wakeLock: null,
    packetCount: 0,
    lastPublishedCoords: null,
    // Viewer specific state
    viewer: {
        cID: null,
        key: null,
        sharerName: "Someone",
        exp: null,
        coords: null,
        history: [], // Array of [lat, lng] for breadcrumbs
        lastPingTime: null,
        myWatchId: null,
        myCoords: null
    },
    // Leaflet map objects
    map: null,
    tileLayer: null,
    sharerMarker: null,
    viewerMarker: null, // Viewer's own location marker
    breadcrumbsPolyline: null,
    // MQTT connection state
    mqttClient: null,
    currentBrokerIndex: 0,
    isConnectingMqtt: false
};

// DOM Elements
const el = {
    themeToggle: document.getElementById('theme-toggle'),
    dashboardView: document.getElementById('dashboard-view'),
    sharingView: document.getElementById('sharing-view'),
    viewerView: document.getElementById('viewer-view'),
    mapContainer: document.getElementById('map-container'),
    
    // Dashboard setup
    sharerNameInput: document.getElementById('sharer-name'),
    durationButtons: document.querySelectorAll('.duration-btn'),
    btnStartShare: document.getElementById('btn-start-share'),
    
    // Sharing view
    sharingTimer: document.getElementById('sharing-timer'),
    shareUrlInput: document.getElementById('share-url'),
    btnCopyLink: document.getElementById('btn-copy-link'),
    btnShareApi: document.getElementById('btn-share-api'),
    statAccuracy: document.getElementById('stat-accuracy'),
    statSpeed: document.getElementById('stat-speed'),
    statPackets: document.getElementById('stat-packets'),
    wifiIcon: document.getElementById('wifi-icon'),
    networkStatusText: document.getElementById('network-status-text'),
    btnStopShare: document.getElementById('btn-stop-share'),
    
    // Viewer view
    viewerSharerName: document.getElementById('viewer-sharer-name'),
    viewerTimer: document.getElementById('viewer-timer'),
    viewerStatusText: document.getElementById('viewer-status-text'),
    viewerPulse: document.getElementById('viewer-pulse'),
    viewStatSpeed: document.getElementById('view-stat-speed'),
    viewStatDistance: document.getElementById('view-stat-distance'),
    viewStatPing: document.getElementById('view-stat-ping'),
    btnDirections: document.getElementById('btn-directions'),
    btnRecenter: document.getElementById('btn-recenter'),
    btnToggleMyLocation: document.getElementById('btn-toggle-my-location'),
    
    // Toast & Loader
    toastContainer: document.getElementById('toast-container'),
    globalLoader: document.getElementById('global-loader'),
    loaderText: document.getElementById('loader-text')
};

// --- INITIALIZATION ---

document.addEventListener('DOMContentLoaded', () => {
    // Initialize Lucide Icons
    lucide.createIcons();
    
    // 1. Theme Check (from localStorage or system preference)
    const savedTheme = localStorage.getItem('pnear-theme');
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(savedTheme || (systemDark ? 'dark' : 'light'));
    
    // 2. Set Up Event Listeners
    setupEventListeners();
    
    // 3. Router logic
    routeApp();
    
    // 4. Timer Tick for active counts
    setInterval(updateCountdownTimers, 1000);
});

// --- ROUTER AND STATE PERSISTENCE ---

function routeApp() {
    const urlParams = new URLSearchParams(window.location.search);
    const shareCID = urlParams.get('share');
    const hashKey = window.location.hash ? window.location.hash.substring(1) : null;
    
    if (shareCID && hashKey) {
        // Mode: Viewer
        state.mode = 'viewer';
        state.viewer.cID = shareCID;
        state.viewer.key = hashKey;
        
        switchView('viewer');
        initMap();
        initMqttViewer();
    } else {
        // Mode: Sharer / Dashboard
        // Check if there is an active local storage share session
        const storedShare = localStorage.getItem('pnear-active-share');
        if (storedShare) {
            const parsed = JSON.parse(storedShare);
            const now = Date.now();
            
            if (parsed.exp > now) {
                // Restore active sharing session
                state.mode = 'sharing';
                state.activeShare = parsed;
                switchView('sharing');
                initMap();
                
                // Set sharing URL in inputs
                const shareUrl = `${window.location.origin}${window.location.pathname}?share=${parsed.cID}#${parsed.key}`;
                el.shareUrlInput.value = shareUrl;
                
                // Initialize background components
                startLocationSharing();
                return;
            } else {
                // Expired share session, clear it
                localStorage.removeItem('pnear-active-share');
            }
        }
        
        // Default: Dashboard Setup
        state.mode = 'dashboard';
        switchView('dashboard');
    }
}

function switchView(viewName) {
    el.dashboardView.classList.add('hidden');
    el.sharingView.classList.add('hidden');
    el.viewerView.classList.add('hidden');
    
    el.dashboardView.classList.remove('active');
    el.sharingView.classList.remove('active');
    el.viewerView.classList.remove('active');
    
    if (viewName === 'dashboard') {
        el.dashboardView.classList.remove('hidden');
        el.dashboardView.classList.add('active');
        el.mapContainer.classList.add('hidden');
    } else if (viewName === 'sharing') {
        el.sharingView.classList.remove('hidden');
        el.sharingView.classList.add('active');
        el.mapContainer.classList.remove('hidden');
    } else if (viewName === 'viewer') {
        el.viewerView.classList.remove('hidden');
        el.viewerView.classList.add('active');
        el.mapContainer.classList.remove('hidden');
    }
}

// --- THEMING ---

function setTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('pnear-theme', theme);
    
    // Update map tiles if map exists
    if (state.map && state.tileLayer) {
        state.map.removeLayer(state.tileLayer);
        state.tileLayer = L.tileLayer(MAP_THEMES[theme].url, {
            attribution: MAP_THEMES[theme].attribution,
            maxZoom: 19
        }).addTo(state.map);
    }
}

// --- EVENT LISTENERS SETUP ---

function setupEventListeners() {
    // Theme Toggle
    el.themeToggle.addEventListener('click', () => {
        setTheme(state.theme === 'dark' ? 'light' : 'dark');
    });
    
    // Duration Buttons Selector
    el.durationButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            el.durationButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
    
    // Start Sharing Button
    el.btnStartShare.addEventListener('click', handleStartShare);
    
    // Copy Share Link Button
    el.btnCopyLink.addEventListener('click', copyShareLink);
    
    // Native Share API Button
    el.btnShareApi.addEventListener('click', shareViaApi);
    
    // Stop Sharing Button
    el.btnStopShare.addEventListener('click', confirmStopSharing);
    
    // Viewer: Recenter Button
    el.btnRecenter.addEventListener('click', recenterMapOnSharer);
    
    // Viewer: Directions Button
    el.btnDirections.addEventListener('click', openDirections);
    
    // Viewer: Toggle personal location tracker (to see distance)
    el.btnToggleMyLocation.addEventListener('click', toggleViewerLocation);
}

// --- UI UTILITIES (TOASTS & LOADERS) ---

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let iconName = 'info';
    if (type === 'success') iconName = 'check-circle';
    if (type === 'warning') iconName = 'alert-triangle';
    if (type === 'error') iconName = 'x-circle';
    
    toast.innerHTML = `
        <i data-lucide="${iconName}"></i>
        <span>${message}</span>
    `;
    
    el.toastContainer.appendChild(toast);
    lucide.createIcons({ attrs: { class: 'toast-icon' } });
    
    // Auto remove after 4 seconds
    setTimeout(() => {
        toast.classList.add('removing');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 4000);
}

function showLoader(text) {
    el.loaderText.innerText = text;
    el.globalLoader.classList.remove('hidden');
}

function hideLoader() {
    el.globalLoader.classList.add('hidden');
}

function formatCountdown(ms) {
    if (ms <= 0) return "Expired";
    const totalSecs = Math.floor(ms / 1000);
    const hours = Math.floor(totalSecs / 3600);
    const minutes = Math.floor((totalSecs % 3600) / 60);
    const seconds = totalSecs % 60;
    
    const pad = (num) => String(num).padStart(2, '0');
    
    if (hours > 0) {
        return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `${pad(minutes)}:${pad(seconds)}`;
}

function updateCountdownTimers() {
    const now = Date.now();
    
    if (state.mode === 'sharing' && state.activeShare) {
        const remaining = state.activeShare.exp - now;
        if (remaining <= 0) {
            el.sharingTimer.innerText = "Expired";
            stopLocationSharing(true); // Auto stop on expiration
        } else {
            el.sharingTimer.innerText = formatCountdown(remaining);
        }
    }
    
    if (state.mode === 'viewer' && state.viewer.exp) {
        const remaining = state.viewer.exp - now;
        if (remaining <= 0) {
            el.viewerTimer.innerText = "Expired";
            el.viewerStatusText.innerText = "Sharing session expired";
            el.viewerPulse.className = "pulse-dot red";
            showToast("This location sharing session has expired.", "warning");
            
            // Clean viewer subscriptions
            if (state.mqttClient) {
                state.mqttClient.end();
            }
        } else {
            el.viewerTimer.innerText = formatCountdown(remaining);
            
            // If it's been more than 25 seconds since the last update, mark user as offline/paused
            if (state.viewer.lastPingTime && (now - state.viewer.lastPingTime > 25000)) {
                el.viewerStatusText.innerText = "Paused / Weak Signal";
                el.viewerPulse.className = "pulse-dot red";
            }
        }
    }
}

// --- SHARER LOGIC ---

function handleStartShare() {
    const rawName = el.sharerNameInput.value.trim();
    const sharerName = rawName || "Anonymous Friend";
    
    // Get active duration
    const activeDurationBtn = document.querySelector('.duration-btn.active');
    const minutes = parseInt(activeDurationBtn.getAttribute('data-minutes'), 10);
    
    // Check permission first
    if (!navigator.geolocation) {
        showToast("Geolocation is not supported by your browser.", "error");
        return;
    }
    
    // Generate sharing credentials instantly
    const cID = "pnear_" + generateRandomId(16);
    const key = generateRandomId(24); // Crypto key
    const exp = Date.now() + (minutes * 60 * 1000);
    
    state.activeShare = { cID, key, name: sharerName, exp, duration: minutes };
    localStorage.setItem('pnear-active-share', JSON.stringify(state.activeShare));
    
    // Set URL
    const shareUrl = `${window.location.origin}${window.location.pathname}?share=${cID}#${key}`;
    el.shareUrlInput.value = shareUrl;
    
    // Switch screen to sharing view
    state.mode = 'sharing';
    switchView('sharing');
    initMap();
    
    // Start components (MQTT, Wakelock, Location Watch)
    startLocationSharing();
    
    showToast("Sharing session created! Acquiring location...", "info");
}

function startLocationSharing() {
    state.packetCount = 0;
    el.statPackets.innerText = "0";
    el.statAccuracy.innerText = "Searching...";
    
    // 1. Setup MQTT publisher connection
    initMqttPublisher();
    
    // 2. Setup Screen Wake Lock (to keep mobile screen alive)
    requestWakeLock();
    
    // 3. Start Geolocation Watching
    startWatching(true); // Start with high accuracy
    
    // Listen for wake lock release
    document.addEventListener('visibilitychange', handleVisibilityChange);
}

function startWatching(highAccuracy) {
    if (state.watchId !== null) {
        navigator.geolocation.clearWatch(state.watchId);
    }
    
    state.usingHighAccuracy = highAccuracy;
    
    const geoOptions = {
        enableHighAccuracy: highAccuracy,
        timeout: 8000, // 8 seconds timeout
        maximumAge: 0
    };
    
    state.watchId = navigator.geolocation.watchPosition(
        handleLocationUpdate,
        handleLocationError,
        geoOptions
    );
}

function restartWatchWithLowAccuracy() {
    if (state.usingHighAccuracy) {
        console.log("Switching to low accuracy geolocation watch due to timeout");
        startWatching(false);
    }
}

function handleLocationUpdate(position) {
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    const accuracy = Math.round(position.coords.accuracy);
    const speed = position.coords.speed !== null ? Math.round(position.coords.speed * 3.6) : null; // km/h
    const heading = position.coords.heading;
    
    // Update local stats UI
    el.statAccuracy.innerText = `${accuracy} m`;
    el.statSpeed.innerText = speed !== null ? `${speed} km/h` : "0 km/h";
    
    // Save last coords
    state.lastPublishedCoords = { lat, lng };
    
    // Render on sharer's mini-map
    updateSharerMap(lat, lng, accuracy);
    
    // Publish encrypted update to MQTT
    publishLocationPacket({
        lat,
        lng,
        acc: accuracy,
        spd: speed,
        dir: heading,
        name: state.activeShare.name,
        exp: state.activeShare.exp
    });
}

function handleLocationError(error) {
    console.error("Geolocation watch error:", error);
    
    if (error.code === error.PERMISSION_DENIED) {
        showToast("Location access denied. We need GPS permission to track your movement.", "error");
        stopLocationSharing(false); // Go back to dashboard
    } else if (error.code === error.TIMEOUT) {
        if (state.usingHighAccuracy) {
            showToast("GPS signal weak. Switching to cell/WiFi positioning...", "warning");
            restartWatchWithLowAccuracy();
        } else {
            showToast("GPS signal request timed out.", "warning");
        }
    } else {
        showToast("GPS Signal weak: " + error.message, "warning");
    }
}

function publishLocationPacket(packet) {
    if (!state.mqttClient || !state.mqttClient.connected) {
        console.warn("MQTT client not ready, packet skipped.");
        return;
    }
    
    try {
        const payloadString = JSON.stringify(packet);
        const encrypted = CryptoJS.AES.encrypt(payloadString, state.activeShare.key).toString();
        
        const topic = `pnear/track/${state.activeShare.cID}`;
        state.mqttClient.publish(topic, encrypted, { qos: 1 }, (err) => {
            if (!err) {
                state.packetCount++;
                el.statPackets.innerText = state.packetCount;
            } else {
                console.error("MQTT publish error:", err);
            }
        });
    } catch (e) {
        console.error("Crypto/Publish exception:", e);
    }
}

function confirmStopSharing() {
    if (confirm("Are you sure you want to stop sharing your live location? This will immediately expire your link.")) {
        stopLocationSharing(false);
    }
}

function stopLocationSharing(isAutoExpired = false) {
    showLoader("Stopping sharing session...");
    
    // 1. Notify viewers that sharing stopped
    if (state.mqttClient && state.mqttClient.connected && state.activeShare) {
        try {
            const stopPacket = { status: "stopped", exp: Date.now() };
            const encrypted = CryptoJS.AES.encrypt(JSON.stringify(stopPacket), state.activeShare.key).toString();
            state.mqttClient.publish(`pnear/track/${state.activeShare.cID}`, encrypted, { qos: 1 });
        } catch (e) {
            console.error(e);
        }
    }
    
    // 2. Clear geolocation watch
    if (state.watchId !== null) {
        navigator.geolocation.clearWatch(state.watchId);
        state.watchId = null;
    }
    
    // 3. Release wake lock
    releaseWakeLock();
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    
    // 4. Close MQTT
    if (state.mqttClient) {
        state.mqttClient.end();
        state.mqttClient = null;
    }
    
    // 5. Clean local storage state
    localStorage.removeItem('pnear-active-share');
    state.activeShare = null;
    
    // 6. Reset UI stats
    el.statAccuracy.innerText = "--";
    el.statSpeed.innerText = "--";
    el.statPackets.innerText = "0";
    
    // 7. Remove Map Markers
    resetMapLayers();
    
    setTimeout(() => {
        hideLoader();
        state.mode = 'dashboard';
        switchView('dashboard');
        if (isAutoExpired) {
            showToast("Your sharing session expired.", "warning");
        } else {
            showToast("Location sharing stopped successfully.", "success");
        }
    }, 800);
}

// --- WAKE LOCK (KEEP MOBILE SCREEN ACTIVE) ---

async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            state.wakeLock = await navigator.wakeLock.request('screen');
            console.log("Wake Lock acquired successfully");
        } catch (err) {
            console.warn(`Wake Lock request failed: ${err.message}`);
        }
    }
}

function releaseWakeLock() {
    if (state.wakeLock !== null) {
        state.wakeLock.release().then(() => {
            state.wakeLock = null;
            console.log("Wake Lock released");
        });
    }
}

function handleVisibilityChange() {
    if (state.wakeLock !== null && document.visibilityState === 'visible') {
        requestWakeLock();
    }
}

// --- MQTT CONNECTION LAYER ---

function initMqttPublisher() {
    if (!state.activeShare) return;
    
    updateMqttStatus("connecting", "Connecting to sync broker...");
    connectMqttClient(() => {
        // Subscribing to request topic: this lets viewers ping us to request an immediate update
        const requestTopic = `pnear/request/${state.activeShare.cID}`;
        state.mqttClient.subscribe(requestTopic, { qos: 1 }, (err) => {
            if (!err) {
                console.log("Subscribed to immediate update request channel:", requestTopic);
            }
        });
        
        // Publish first location packet immediately if we have it
        if (state.lastPublishedCoords) {
            handleLocationUpdate({
                coords: {
                    latitude: state.lastPublishedCoords.lat,
                    longitude: state.lastPublishedCoords.lng,
                    accuracy: 10, // approximate
                    speed: 0,
                    heading: 0
                }
            });
        }
    });
}

function initMqttViewer() {
    if (!state.viewer.cID) return;
    
    el.viewerStatusText.innerText = "Connecting to sync broker...";
    el.viewerPulse.className = "pulse-dot green"; // Green represents attempting
    
    connectMqttClient(() => {
        const trackTopic = `pnear/track/${state.viewer.cID}`;
        state.mqttClient.subscribe(trackTopic, { qos: 1 }, (err) => {
            if (!err) {
                el.viewerStatusText.innerText = "Waiting for location signal...";
                showToast("Connected! Syncing location data...", "info");
                
                // Publish instant ping request to tell the sharer to broadcast immediately
                const requestTopic = `pnear/request/${state.viewer.cID}`;
                state.mqttClient.publish(requestTopic, "ping", { qos: 1 });
            } else {
                console.error("Subcription error:", err);
                showToast("Failed to subscribe to tracking data.", "error");
            }
        });
    });
}

function connectMqttClient(onConnectCallback) {
    if (state.mqttClient) {
        state.mqttClient.end(true);
    }
    
    const broker = BROKERS[state.currentBrokerIndex];
    console.log(`Connecting to MQTT broker: ${broker.name} (${broker.url})`);
    
    state.isConnectingMqtt = true;
    
    // Set a timeout to switch brokers if connection hangs
    const fallbackTimeout = setTimeout(() => {
        if (state.isConnectingMqtt) {
            console.warn(`Connection to ${broker.name} timed out. Attempting next broker...`);
            handleMqttConnectionFallback(onConnectCallback);
        }
    }, 6000);
    
    try {
        state.mqttClient = mqtt.connect(broker.url, {
            clientId: 'pnear_' + Math.random().toString(36).substr(2, 9),
            connectTimeout: 5000,
            reconnectPeriod: 10000,
            keepalive: 60,
            clean: true
        });
        
        state.mqttClient.on('connect', () => {
            clearTimeout(fallbackTimeout);
            state.isConnectingMqtt = false;
            state.connectionAttempts = 0; // Reset counter on success
            console.log(`Connected to broker: ${broker.name}`);
            
            if (state.mode === 'sharing') {
                updateMqttStatus("connected", `Syncing via ${broker.name}`);
            } else if (state.mode === 'viewer') {
                el.viewerStatusText.innerText = "Syncing live location...";
                el.viewerPulse.className = "pulse-dot green";
            }
            
            if (onConnectCallback) onConnectCallback();
        });
        
        state.mqttClient.on('message', (topic, message) => {
            handleMqttIncomingMessage(topic, message.toString());
        });
        
        state.mqttClient.on('error', (err) => {
            console.error("MQTT client error:", err);
            // Let the timeout or offline handler deal with it
        });
        
        state.mqttClient.on('offline', () => {
            console.warn("MQTT client offline.");
            if (state.mode === 'sharing') {
                updateMqttStatus("offline", "Network offline. Retrying...");
            }
        });
        
    } catch (e) {
        clearTimeout(fallbackTimeout);
        state.isConnectingMqtt = false;
        console.error("MQTT connect syntax error:", e);
        handleMqttConnectionFallback(onConnectCallback);
    }
}

function handleMqttConnectionFallback(onConnectCallback) {
    if (state.mqttClient) {
        state.mqttClient.end(true);
        state.mqttClient = null;
    }
    
    // Move to next broker index with circular boundary
    state.currentBrokerIndex = (state.currentBrokerIndex + 1) % BROKERS.length;
    const nextBroker = BROKERS[state.currentBrokerIndex];
    console.log(`Switching sync node to: ${nextBroker.name}`);
    
    state.connectionAttempts = (state.connectionAttempts || 0) + 1;
    if (state.connectionAttempts >= BROKERS.length) {
        showToast("Slow connection. If using Brave or an AdBlocker, try pausing Shields.", "warning");
    }
    
    if (state.mode === 'sharing') {
        updateMqttStatus("connecting", `Trying network node ${state.currentBrokerIndex + 1}...`);
    } else if (state.mode === 'viewer') {
        el.viewerStatusText.innerText = `Retrying node ${state.currentBrokerIndex + 1}...`;
    }
    
    // Reconnect after brief pause
    setTimeout(() => {
        connectMqttClient(onConnectCallback);
    }, 1500);
}

function updateMqttStatus(status, text) {
    el.networkStatusText.innerText = text;
    
    if (status === 'connected') {
        el.wifiIcon.className = "status-icon green";
        el.wifiIcon.setAttribute('data-lucide', 'wifi');
    } else if (status === 'connecting') {
        el.wifiIcon.className = "status-icon warning";
        el.wifiIcon.setAttribute('data-lucide', 'wifi-off');
    } else {
        el.wifiIcon.className = "status-icon danger";
        el.wifiIcon.setAttribute('data-lucide', 'wifi-off');
    }
    lucide.createIcons({ attrs: { class: 'status-icon' } });
}

function handleMqttIncomingMessage(topic, ciphertext) {
    // 1. Sharer: Check for PING request from new viewers
    if (state.mode === 'sharing' && state.activeShare) {
        const requestTopic = `pnear/request/${state.activeShare.cID}`;
        if (topic === requestTopic && ciphertext === "ping") {
            console.log("Immediate update requested by viewer. Broadcasting coordinates.");
            // If we have coordinates, push update instantly
            if (state.lastPublishedCoords) {
                // Request current position asynchronously to publish freshest accuracy
                navigator.geolocation.getCurrentPosition((pos) => {
                    handleLocationUpdate(pos);
                }, () => {
                    // Fallback to last known coords
                    publishLocationPacket({
                        lat: state.lastPublishedCoords.lat,
                        lng: state.lastPublishedCoords.lng,
                        acc: 15,
                        spd: 0,
                        name: state.activeShare.name,
                        exp: state.activeShare.exp
                    });
                }, { enableHighAccuracy: state.usingHighAccuracy, timeout: 5000 });
            }
        }
        return;
    }
    
    // 2. Viewer: Decrypt location updates
    if (state.mode === 'viewer' && state.viewer.cID) {
        const trackTopic = `pnear/track/${state.viewer.cID}`;
        if (topic === trackTopic) {
            try {
                // Decrypt ciphertext using key
                const bytes = CryptoJS.AES.decrypt(ciphertext, state.viewer.key);
                const decryptedStr = bytes.toString(CryptoJS.enc.Utf8);
                
                if (!decryptedStr) {
                    console.error("Decrypted string is empty. Incorrect decryption key!");
                    return;
                }
                
                const packet = JSON.parse(decryptedStr);
                
                // Handle stopped packet
                if (packet.status === "stopped") {
                    el.viewerStatusText.innerText = "Sharing stopped by user";
                    el.viewerPulse.className = "pulse-dot red";
                    showToast(`${state.viewer.sharerName} has stopped sharing their location.`, "warning");
                    if (state.mqttClient) state.mqttClient.end();
                    return;
                }
                
                // Process fresh position
                state.viewer.sharerName = packet.name;
                state.viewer.exp = packet.exp;
                state.viewer.lastPingTime = Date.now();
                state.viewer.coords = { lat: packet.lat, lng: packet.lng };
                
                // Update header info
                el.viewerSharerName.innerText = packet.name;
                el.viewerStatusText.innerText = "Live";
                el.viewerPulse.className = "pulse-dot green";
                
                // Speed & Ping UI
                el.viewStatSpeed.innerText = packet.spd !== null ? `${packet.spd} km/h` : "0 km/h";
                el.viewStatPing.innerText = "Just now";
                
                // Calculate distance if viewer enabled their own location
                updateDistanceUI();
                
                // Update Map
                updateViewerMap(packet.lat, packet.lng, packet.acc);
                
            } catch (e) {
                console.error("Failed to decrypt or parse MQTT packet:", e);
            }
        }
    }
}

// --- LEAFLET MAP RENDERER ---

function initMap() {
    if (state.map) return; // Map already loaded
    
    // Setup Map container
    state.map = L.map('map', {
        zoomControl: true,
        attributionControl: true
    }).setView([26.8206, 30.8025], 5); // Default center (Egypt/Middle East area, zoom out)
    
    // Load thematic tiles
    state.tileLayer = L.tileLayer(MAP_THEMES[state.theme].url, {
        attribution: MAP_THEMES[state.theme].attribution,
        maxZoom: 19
    }).addTo(state.map);
    
    // Reposition zoom controls
    state.map.zoomControl.setPosition('bottomright');
}

function resetMapLayers() {
    if (state.sharerMarker) {
        state.map.removeLayer(state.sharerMarker);
        state.sharerMarker = null;
    }
    if (state.viewerMarker) {
        state.map.removeLayer(state.viewerMarker);
        state.viewerMarker = null;
    }
    if (state.breadcrumbsPolyline) {
        state.map.removeLayer(state.breadcrumbsPolyline);
        state.breadcrumbsPolyline = null;
    }
    state.viewer.history = [];
}

// Sharer's personal map view
function updateSharerMap(lat, lng, accuracy) {
    if (!state.map) return;
    
    const latlng = [lat, lng];
    
    if (!state.sharerMarker) {
        // Create custom marker with blue pulse ring
        const customIcon = L.divIcon({
            className: 'custom-marker',
            html: '<div class="marker-pin-outer"><div class="marker-pin-inner"></div><div class="marker-pulse-ring"></div></div>',
            iconSize: [30, 30],
            iconAnchor: [15, 15]
        });
        
        state.sharerMarker = L.marker(latlng, { icon: customIcon }).addTo(state.map);
        
        // Fit view to marker
        state.map.setView(latlng, 16);
    } else {
        state.sharerMarker.setLatLng(latlng);
    }
}

// Viewer's view of the sharer's location
function updateViewerMap(lat, lng, accuracy) {
    if (!state.map) return;
    
    const latlng = [lat, lng];
    
    // Add point to tracking history (breadcrumbs)
    // Avoid repeating coordinates to keep line clean
    const historyLen = state.viewer.history.length;
    if (historyLen === 0 || (state.viewer.history[historyLen-1][0] !== lat || state.viewer.history[historyLen-1][1] !== lng)) {
        state.viewer.history.push(latlng);
    }
    
    if (!state.sharerMarker) {
        // Create custom tracking marker
        const customIcon = L.divIcon({
            className: 'custom-marker',
            html: '<div class="marker-pin-outer"><div class="marker-pin-inner"></div><div class="marker-pulse-ring"></div></div>',
            iconSize: [30, 30],
            iconAnchor: [15, 15]
        });
        
        state.sharerMarker = L.marker(latlng, { icon: customIcon }).addTo(state.map);
        
        // Draw path polyline (dotted primary line)
        state.breadcrumbsPolyline = L.polyline(state.viewer.history, {
            color: 'var(--primary)',
            weight: 3,
            opacity: 0.8,
            dashArray: '5, 8'
        }).addTo(state.map);
        
        // Auto zoom and pan to fit
        state.map.setView(latlng, 16);
    } else {
        // Smooth transition
        state.sharerMarker.setLatLng(latlng);
        
        if (state.breadcrumbsPolyline) {
            state.breadcrumbsPolyline.setLatLngs(state.viewer.history);
        }
    }
}

function recenterMapOnSharer() {
    if (state.mode === 'viewer' && state.viewer.coords) {
        state.map.setView([state.viewer.coords.lat, state.viewer.coords.lng], 16);
        showToast("Centered on user's location", "info");
    } else if (state.mode === 'sharing' && state.lastPublishedCoords) {
        state.map.setView([state.lastPublishedCoords.lat, state.lastPublishedCoords.lng], 16);
        showToast("Centered on your location", "info");
    } else {
        showToast("No location data available yet.", "warning");
    }
}

// Viewer tracking their own location
function toggleViewerLocation() {
    if (state.viewer.myWatchId !== null) {
        // Disable own location tracking
        navigator.geolocation.clearWatch(state.viewer.myWatchId);
        state.viewer.myWatchId = null;
        state.viewer.myCoords = null;
        
        if (state.viewerMarker) {
            state.map.removeLayer(state.viewerMarker);
            state.viewerMarker = null;
        }
        
        el.btnToggleMyLocation.querySelector('span').innerText = "Show my location to measure distance";
        el.viewStatDistance.innerText = "--";
        showToast("Disabled viewer location tracking", "info");
    } else {
        // Enable own location tracking
        if (!navigator.geolocation) {
            showToast("Geolocation is not supported by your browser.", "error");
            return;
        }
        
        el.btnToggleMyLocation.querySelector('span').innerText = "Acquiring your location...";
        
        state.viewer.myWatchId = navigator.geolocation.watchPosition(
            (pos) => {
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                state.viewer.myCoords = { lat, lng };
                
                el.btnToggleMyLocation.querySelector('span').innerText = "Hide my location";
                
                // Plot viewer marker (green dot)
                const latlng = [lat, lng];
                if (!state.viewerMarker) {
                    const viewerIcon = L.divIcon({
                        className: 'custom-viewer-marker',
                        html: '<div class="viewer-marker-pin-outer"><div class="viewer-marker-pin-inner"></div></div>',
                        iconSize: [24, 24],
                        iconAnchor: [12, 12]
                    });
                    state.viewerMarker = L.marker(latlng, { icon: viewerIcon }).addTo(state.map);
                } else {
                    state.viewerMarker.setLatLng(latlng);
                }
                
                // Update distance
                updateDistanceUI();
            },
            (err) => {
                console.error("Viewer track own position error:", err);
                showToast("Failed to acquire your location: " + err.message, "warning");
                state.viewer.myWatchId = null;
                el.btnToggleMyLocation.querySelector('span').innerText = "Show my location to measure distance";
            },
            { enableHighAccuracy: true }
        );
    }
}

function updateDistanceUI() {
    if (state.viewer.coords && state.viewer.myCoords) {
        const dist = calculateHaversineDistance(state.viewer.coords, state.viewer.myCoords);
        el.viewStatDistance.innerText = dist;
    } else {
        el.viewStatDistance.innerText = "--";
    }
}

function calculateHaversineDistance(coords1, coords2) {
    const R = 6371; // Earth's radius in km
    const dLat = (coords2.lat - coords1.lat) * Math.PI / 180;
    const dLon = (coords2.lng - coords1.lng) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(coords1.lat * Math.PI / 180) * Math.cos(coords2.lat * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const d = R * c;
    
    if (d < 1) {
        return Math.round(d * 1000) + " m";
    }
    return d.toFixed(2) + " km";
}

function openDirections() {
    if (state.mode === 'viewer' && state.viewer.coords) {
        const lat = state.viewer.coords.lat;
        const lng = state.viewer.coords.lng;
        
        // Open Navigation (universal link, maps will trigger native app or Google maps web)
        const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
        window.open(url, '_blank');
    } else {
        showToast("No destination coordinates acquired yet.", "warning");
    }
}

// --- UTILITIES (CRYPTOGRAPHY & HELPERS) ---

function generateRandomId(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function copyShareLink() {
    const shareUrl = el.shareUrlInput.value;
    if (!shareUrl) return;
    
    navigator.clipboard.writeText(shareUrl).then(() => {
        // Update Copy Icon to Checkmark temporarily
        const copyIcon = el.btnCopyLink.querySelector('.copy-default');
        const successIcon = el.btnCopyLink.querySelector('.copy-success');
        
        copyIcon.classList.add('hidden');
        successIcon.classList.remove('hidden');
        
        showToast("Sharing link copied to clipboard!", "success");
        
        setTimeout(() => {
            copyIcon.classList.remove('hidden');
            successIcon.classList.add('hidden');
        }, 2000);
    }).catch(err => {
        console.error("Clipboard copy failed:", err);
        showToast("Failed to copy link. Please manually copy the input field.", "error");
    });
}

function shareViaApi() {
    const shareUrl = el.shareUrlInput.value;
    if (!shareUrl) return;
    
    if (navigator.share) {
        navigator.share({
            title: 'P-Near - My Live Location',
            text: `Follow my live location on P-Near:`,
            url: shareUrl
        }).then(() => {
            console.log("Shared successfully");
        }).catch(err => {
            console.warn("Share API cancelled or failed:", err);
        });
    } else {
        // Fallback: Copy link and show toast
        copyShareLink();
    }
}
