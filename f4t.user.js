// ==UserScript==
// @name         Free4Talk Analyzer
// @version      16.3.23
// @author       You
// @match        https://www.free4talk.com/
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    unsafeWindow.F4T_DB = unsafeWindow.F4T_DB || new Map();
    let isOverlayOpen = false;
    let refreshInterval = null;

    // --- Configuration ---
    const STORAGE_KEY = 'f4t_settings';

    const F4T_LEVELS = [
        "Any Level", "Beginner", "Upper Beginner", 
        "Intermediate", "Upper Intermediate", 
        "Advanced", "Upper Advanced"
    ];

    const DEFAULT_SETTINGS = {
        lang: "English",
        secLang: "",
        minSlots: 1,
        sort: "score_desc",
        reqMic: true,
        levels: [...F4T_LEVELS]
    };

    // --- Helper: Settings ---
    function getSettings() {
        const stored = GM_getValue(STORAGE_KEY, null);
        if (stored) {
            try { return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) }; } 
            catch (e) {}
        }
        return DEFAULT_SETTINGS;
    }

    function saveSettings(settings) {
        GM_setValue(STORAGE_KEY, JSON.stringify(settings));
    }

    // --- Groups Data ---
    const originalFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);
        const url = args[0] ? args[0].toString() : '';

        if (url.includes('/sync/get/free4talk/groups')) {
            const clone = response.clone();
            clone.json().then(json => {
                if (json && json.data) {
                    Object.values(json.data).forEach(room => {
                        if (room.id) unsafeWindow.F4T_DB.set(room.id, room);
                    });
                    updateLaunchButton(unsafeWindow.F4T_DB.size);
                }
            }).catch(() => {});
        }
        return response;
    };

    function calculateIndividualScore(c) {
        const following = c.following || 0;
        const followers = c.followers || 0;
        const friends = c.friends || 0;

        const n = following + followers - friends;
        c.score = (friends + 1) / (n + 2);
        c.score *= 1 - 0.5 * (Math.abs(following - friends) + 1) / (n + 2);
        c.score *= 1 - 0.5 * (Math.abs(followers - friends) + 1) / (n + 2);

        return c.score;
    }

    function calculateRoomScore(room) {
        if (!room.clients || room.clients.length === 0) return 0;

        let scores = room.clients.map(calculateIndividualScore);
        let total = scores.reduce((acc, val) => acc + val, 0);

        return Math.round((total + 0.5) / (scores.length + 1) * 1000) / 100
    }

    // --- UI Logic ---
    function openOverlay() {
        if (document.getElementById('f4t-overlay')) return;
        document.body.classList.add('f4t-focus-mode');

        const overlay = document.createElement('div');
        overlay.id = 'f4t-overlay';
        
        const levelChecksHtml = F4T_LEVELS.map(lvl => `
            <label class="f4t-chip">
                <input type="checkbox" value="${lvl}" class="f4t-level-cb">
                <span>${lvl}</span>
            </label>
        `).join('');

        overlay.innerHTML = `
        <div class="f4t-panel">
            <div class="f4t-header">
                <div class="f4t-brand">
                    <h2>F4T Analyzer</h2>
                    <div class="f4t-counts">
                        <span id="f4t-match-count">0</span> / <span id="f4t-total-count">0</span>
                    </div>
                </div>
                <div class="f4t-search-container">
                    <input type="text" id="f4t-search" placeholder="Search topic or user...">
                </div>
                <button id="f4t-close">✕</button>
            </div>

            <div class="f4t-toolbar">
                <div class="f4t-field">
                    <label>Lang</label>
                    <input type="text" id="f4t-lang" placeholder="Any">
                </div>
                <div class="f4t-field" style="flex:1.5">
                    <label>2nd Lang</label>
                    <input type="text" id="f4t-sec" placeholder="e.g. None, Spanish">
                </div>
                <div class="f4t-field" style="flex:0.8">
                    <label>Free Slots</label>
                    <input type="number" id="f4t-slots" value="1" min="0">
                </div>
                <div class="f4t-field" style="flex:1.5">
                    <label>Sort</label>
                    <select id="f4t-sort">
                        <option value="score_desc">High Score</option>
                        <option value="recent">Newest First</option>
                        <option value="full">Total Score</option>
                    </select>
                </div>
                <div class="f4t-field-btn">
                    <label class="f4t-toggle-btn">
                        <input type="checkbox" id="f4t-req-mic">
                        <span>🎤 Mic On</span>
                    </label>
                </div>
            </div>

            <div class="f4t-level-bar">${levelChecksHtml}</div>
            <div id="f4t-grid" class="f4t-grid"></div>
        </div>
        `;

        document.body.appendChild(overlay);

        // Restore Settings
        const s = getSettings();
        document.getElementById('f4t-lang').value = s.lang || "";
        document.getElementById('f4t-sec').value = s.secLang || "";
        document.getElementById('f4t-slots').value = (s.minSlots !== undefined) ? s.minSlots : 1;
        document.getElementById('f4t-sort').value = s.sort || "score_desc";
        document.getElementById('f4t-req-mic').checked = !!s.reqMic;
        overlay.querySelectorAll('.f4t-level-cb').forEach(cb => {
            cb.checked = s.levels.includes(cb.value);
        });

        overlay.querySelectorAll('input, select').forEach(el => {
            el.addEventListener('input', () => { render(); }); 
            el.addEventListener('change', () => { render(); }); 
        });

        document.getElementById('f4t-close').onclick = closeOverlay;

        isOverlayOpen = true;
        render();
        refreshInterval = setInterval(render, 5000);
    }

    function closeOverlay() {
        const overlay = document.getElementById('f4t-overlay');
        if (overlay) overlay.remove();
        document.body.classList.remove('f4t-focus-mode');
        isOverlayOpen = false;
        if (refreshInterval) clearInterval(refreshInterval);
    }

    function render() {
        if (!isOverlayOpen) return;

        // 1. Gather Inputs
        const searchVal = document.getElementById('f4t-search').value.toLowerCase().trim();
        const langVal = document.getElementById('f4t-lang').value.trim();
        const secValRaw = document.getElementById('f4t-sec').value;
        const slotsVal = parseInt(document.getElementById('f4t-slots').value);
        const slotsNum = isNaN(slotsVal) ? 0 : slotsVal; 
        const sortVal = document.getElementById('f4t-sort').value;
        const micVal = document.getElementById('f4t-req-mic').checked;
        const levelVals = Array.from(document.querySelectorAll('.f4t-level-cb:checked')).map(cb => cb.value);

        // 2. Save
        saveSettings({
            lang: langVal, secLang: secValRaw, minSlots: slotsNum,
            sort: sortVal, reqMic: micVal, levels: levelVals
        });

        // 3. Process Logic
        const secList = secValRaw.split(',')
            .map(s => s.trim())
            .filter(s => s !== "")
            .map(s => s.toLowerCase() === 'none' ? "" : s);

        const matchBadge = document.getElementById('f4t-match-count');
        const totalBadge = document.getElementById('f4t-total-count');
        const grid = document.getElementById('f4t-grid');

        let items = Array.from(unsafeWindow.F4T_DB.values()).map(room => ({
            ...room,
            _score: calculateRoomScore(room),
            _date: new Date(room.createdAt),
            _isNew: (Date.now() - new Date(room.createdAt).getTime()) < 1000 * 60 * 10
        }));

        items = items.filter(i => {
            let pass = true;
            if (searchVal) {
                const topicMatch = (i.topic || "").toLowerCase().includes(searchVal);
                const userMatch = i.clients.some(c => (c.name || "").toLowerCase().includes(searchVal));
                pass = topicMatch || userMatch;
            }
            if (pass && langVal && i.language !== langVal) pass = false;
            if (pass && !levelVals.includes(i.level)) pass = false;
            
            // Slots filter
            if (pass) {
                if (!i.clients || i.clients.length === 0) pass = false;
                else if (i.maxPeople > 0 && (i.maxPeople - i.clients.length < slotsNum)) pass = false;
            }
            
            // 2nd Lang filter
            if (pass && secValRaw.trim() !== "") {
                const roomSec = i.secondLanguage || "";
                pass = secList.includes(roomSec);
            }

            if (pass && micVal && i.settings.noMic) pass = false;
            if (pass && i.settings.isLocked) pass = false;
            return pass;
        });

        items.sort((a, b) => {
            if (sortVal === 'score_desc') return b._score - a._score;
            if (sortVal === 'recent') return b._date - a._date;
            if (sortVal === 'full') return b.clients.length * b._score - a.clients.length * a._score;
            return 0;
        });

        if (matchBadge) matchBadge.textContent = items.length;
        if (totalBadge) totalBadge.textContent = unsafeWindow.F4T_DB.size;

        if (items.length === 0) {
            grid.innerHTML = '<div class="f4t-empty">No matching rooms found...</div>';
            return;
        }

        grid.innerHTML = items.map(item => {
            // --- ROOM SCORE COLOR LOGIC ---
            let cardClass = 'f4t-card-pos'; // Default Green (>= 5.0)
            let btnClass = 'f4t-btn-safe';
            let btnText = 'Join';

            if (item._score < 2.5) {
                cardClass = 'f4t-card-neg';
                btnClass = 'f4t-btn-risky';
            } else if (item._score < 5.0) {
                cardClass = 'f4t-card-neu';
            }

            const members = item.clients.map(c => {
                const isHost = c.id === item.creator.id;
                
                // --- USER COLORS (0.25 / 0.5) ---
                const uScore = calculateIndividualScore(c);
                const statColor = uScore < 0.25 ? '#ff5252' : (uScore < 0.5 ? '#ffb74d' : '#66bb6a');
                
                const diff = (c.following || 0) - (c.followers || 0);

                return `
                <div class="f4t-mem">
                    <div class="f4t-ava-wrap">
                        <img src="${c.avatar}" class="f4t-ava" loading="lazy">
                        ${isHost ? '<span class="f4t-host-badge">HOST</span>' : ''}
                    </div>
                    <div class="f4t-mem-info">
                        <div class="f4t-mem-name">${escapeHtml(c.name)}</div>
                        <div class="f4t-mem-stats" style="color:${statColor}">
                            Diff: ${diff} | Fr: ${c.friends}
                        </div>
                    </div>
                </div>`;
            }).join('');

            return `
            <div class="f4t-card ${cardClass}">
                <div class="f4t-card-head">
                    <div class="f4t-head-left">
                        <div class="f4t-topic" title="${escapeHtml(item.topic)}">${escapeHtml(item.topic || "No Topic")}</div>
                        <div class="f4t-meta">
                            by ${escapeHtml(item.creator.name)} • ${getTimeAgo(item._date)}
                            ${item._isNew ? '<span class="f4t-fresh">✨ NEW</span>' : ''}
                        </div>
                    </div>
                    <div class="f4t-score-box" data-val="${item._score.toFixed(2)}">
                        ${item._score.toFixed(2)}
                    </div>
                </div>
                <div class="f4t-tags">
                    <span class="f4t-tag f4t-tag-lang">${escapeHtml(item.language)}</span>
                    <span class="f4t-tag f4t-tag-base">${escapeHtml(item.level)}</span>
                    ${item.secondLanguage ? `<span class="f4t-tag f4t-tag-sec">${escapeHtml(item.secondLanguage)}</span>` : ''}
                </div>
                <div class="f4t-members">${members}</div>
                <div class="f4t-footer">
                    <div class="f4t-cap">👥 ${item.clients.length} / ${item.maxPeople || '∞'}</div>
                    <a href="${item.url}" target="_blank" class="f4t-join ${btnClass}">${btnText}</a>
                </div>
            </div>`;
        }).join('');
    }

    function escapeHtml(t) { return t ? t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;") : ""; }
    function getTimeAgo(d) {
        const m = Math.floor((new Date() - d) / 60000);
        if(m < 1) return "Now";
        if(m < 60) return m + "m"; 
        const h = Math.floor(m / 60); return h < 24 ? h + "h" : Math.floor(h / 24) + "d";
    }
    function updateLaunchButton(t) {
        const btn = document.getElementById('f4t-launch-btn');
        if(btn) { btn.textContent = `🔍 (${t})`; btn.classList.add('pulse'); setTimeout(()=>btn.classList.remove('pulse'),500); }
    }

    window.addEventListener('load', () => {
        const btn = document.createElement('button');
        btn.innerHTML = "🔍 (0)"; btn.id = "f4t-launch-btn";
        btn.onclick = openOverlay; document.body.appendChild(btn);
        injectStyles();
    });

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            body.f4t-focus-mode { overflow: hidden !important; background: #121212 !important; }
            body.f4t-focus-mode > *:not(#f4t-overlay):not(#f4t-launch-btn) { display: none !important; }

            #f4t-launch-btn {
                position: fixed; bottom: 20px; left: 20px;
                background: linear-gradient(135deg, #1e1e1e, #2a2a2a); color: #66bb6a;
                border: 1px solid #333; padding: 10px 24px; border-radius: 50px;
                font-weight: 700; z-index: 9999; box-shadow: 0 4px 15px rgba(0,0,0,0.5);
                cursor: pointer; transition: 0.2s; font-family: system-ui;
            }
            #f4t-launch-btn:hover { transform: scale(1.05); color: #81c784; }
            #f4t-launch-btn.pulse { box-shadow: 0 0 15px #66bb6a; border-color: #66bb6a; }

            #f4t-overlay {
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: #0a0a0a; z-index: 10000; display: flex;
                font-family: 'Segoe UI', system-ui, sans-serif;
            }
            .f4t-panel {
                width: 96%; max-width: 1600px; height: 100%; margin: 0 auto;
                background: #121212; border-left: 1px solid #222; border-right: 1px solid #222;
                display: flex; flex-direction: column;
            }

            .f4t-header {
                display: flex; align-items: center; padding: 15px 25px;
                background: #181818; border-bottom: 1px solid #2a2a2a; gap: 20px;
            }
            .f4t-brand h2 { margin: 0; color: #66bb6a; font-size: 1.5rem; letter-spacing: -0.5px; }
            .f4t-counts { color: #666; font-size: 0.9rem; font-weight: bold; margin-top: 4px; }
            
            /* Search Bar */
            .f4t-search-container { flex: 1; display: flex; }
            #f4t-search {
                width: 100%; background: #000; border: 1px solid #333; color: #eee;
                padding: 10px 18px; border-radius: 8px; font-size: 1rem;
            }
            #f4t-search:focus { border-color: #66bb6a; outline: none; }
            #f4t-close { background: none; border: none; color: #666; font-size: 1.8rem; cursor: pointer; padding: 0 15px; }
            #f4t-close:hover { color: #fff; }

            .f4t-toolbar {
                display: flex; gap: 15px; padding: 15px 25px; background: #151515;
                border-bottom: 1px solid #2a2a2a; align-items: flex-end; flex-wrap: wrap;
            }
            .f4t-field { display: flex; flex-direction: column; gap: 5px; min-width: 100px; flex: 1; }
            .f4t-field label { font-size: 0.7rem; color: #888; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
            .f4t-field input, .f4t-field select {
                height: 40px; background: #222; border: 1px solid #333; color: #ddd;
                padding: 0 12px; border-radius: 6px; font-size: 0.95rem; width: 100%;
            }
            
            .f4t-toggle-btn {
                height: 40px; display: flex; align-items: center; padding: 0 16px;
                background: #222; border: 1px solid #333; border-radius: 6px;
                cursor: pointer; user-select: none; transition: 0.2s;
            }
            .f4t-toggle-btn input { display: none; }
            .f4t-toggle-btn span { font-size: 0.9rem; color: #aaa; font-weight: 600; }
            .f4t-toggle-btn:has(input:checked) { background: #1b3320; border-color: #4caf50; }
            .f4t-toggle-btn input:checked + span { color: #fff; }

            .f4t-level-bar {
                display: flex; gap: 8px; padding: 10px 25px; background: #151515;
                border-bottom: 1px solid #2a2a2a; overflow-x: auto;
            }
            .f4t-chip input { display: none; }
            .f4t-chip span {
                display: block; padding: 5px 14px; background: #222; border: 1px solid #333;
                border-radius: 50px; font-size: 0.8rem; color: #777; transition: 0.15s; white-space: nowrap; cursor: pointer;
            }
            .f4t-chip input:checked + span {
                background: #2e3b30; color: #81c784; border-color: #4caf50; font-weight: 600;
            }

            .f4t-grid {
                flex: 1; overflow-y: auto; padding: 25px;
                display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
                gap: 20px; align-content: flex-start;
            }
            .f4t-empty { grid-column: 1/-1; text-align: center; margin-top: 80px; color: #444; font-size: 1.2rem; }

            .f4t-card {
                background: #1c1c1c; border: 1px solid #333; border-radius: 10px;
                display: flex; flex-direction: column; overflow: hidden; height: max-content;
                box-shadow: 0 2px 10px rgba(0,0,0,0.2); transition: transform 0.2s;
            }
            .f4t-card:hover { transform: translateY(-3px); border-color: #555; }
            
            /* --- Room Color Classes --- */
            .f4t-card-pos { border: 1px solid #333; }
            .f4t-card-pos:hover { border-color: #66bb6a; }
            .f4t-card-pos .f4t-card-head { background: #222; }
            .f4t-card-pos .f4t-score-box { color: #66bb6a; }

            .f4t-card-neu { border-color: #5d561b; opacity: 0.95; }
            .f4t-card-neu:hover { border-color: #ffee58; opacity: 1; }
            .f4t-card-neu .f4t-score-box { color: #ffee58; }

            .f4t-card-neg { border-color: #4a2a2a; opacity: 0.85; }
            .f4t-card-neg:hover { border-color: #ff5252; opacity: 1; }
            .f4t-card-neg .f4t-score-box { color: #ff5252; }

            .f4t-card-head { padding: 14px; background: #222; border-bottom: 1px solid #2e2e2e; display: flex; justify-content: space-between; }
            .f4t-head-left { overflow: hidden; margin-right: 12px; }
            .f4t-topic { font-weight: 700; color: #eee; font-size: 1.1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .f4t-meta { font-size: 0.8rem; color: #888; margin-top: 4px; display: flex; align-items: center; gap: 8px; }
            .f4t-fresh { color: #ffd700; font-weight: bold; font-size: 0.7rem; background: rgba(255, 215, 0, 0.1); padding: 1px 5px; border-radius: 4px; }

            .f4t-score-box {
                font-family: monospace; font-weight: 700; font-size: 1.2rem;
            }

            .f4t-tags { padding: 8px 14px; background: #1a1a1a; display: flex; gap: 6px; flex-wrap: wrap; }
            .f4t-tag { font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; color: #ddd; background: #333; }
            .f4t-tag-lang { background: #1565C0; color: #fff; }
            .f4t-tag-sec { background: #7B1FA2; color: #fff; }

            .f4t-members { max-height: 220px; overflow-y: auto; background: #181818; flex: 1; }
            .f4t-mem { display: flex; align-items: center; padding: 8px 14px; border-bottom: 1px solid #252525; }
            .f4t-ava-wrap { position: relative; margin-right: 12px; }
            .f4t-ava { width: 36px; height: 36px; border-radius: 50%; border: 2px solid #333; }
            .f4t-host-badge { position: absolute; bottom: -4px; right: -4px; background: #1e88e5; color:#fff; font-size:0.6rem; padding:1px 3px; border-radius: 3px; }
            
            .f4t-mem-info { flex: 1; overflow: hidden; }
            .f4t-mem-name { font-size: 0.95rem; color: #e0e0e0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .f4t-mem-stats { font-size: 0.75rem; color: #666; font-family: monospace; }

            .f4t-footer { padding: 10px 14px; background: #222; border-top: 1px solid #2e2e2e; display: flex; justify-content: space-between; align-items: center; }
            .f4t-cap { font-size: 0.85rem; color: #888; font-weight: 600; }
            
            .f4t-join { text-decoration: none; padding: 6px 18px; border-radius: 6px; font-size: 0.9rem; font-weight: 700; }
            .f4t-btn-safe { background: #4caf50; color: #000; }
            .f4t-btn-safe:hover { background: #66bb6a; }
            .f4t-btn-risky { background: #d32f2f; color: #fff; opacity: 0.8; }
            .f4t-btn-risky:hover { opacity: 1; }
        `;
        document.head.appendChild(style);
    }

})();