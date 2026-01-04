// ==UserScript==
// @name         Free4Talk Analyzer
// @version      14.9.14
// @description  Improve discoverability of F4T rooms
// @author       You
// @match        https://www.free4talk.com/
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // --- Global State ---
    window.F4T_DB = window.F4T_DB || new Map();
    let isOverlayOpen = false;
    let refreshInterval = null;
    
    const F4T_LEVELS = [
        "Any Level", "Beginner", "Upper Beginner", 
        "Intermediate", "Upper Intermediate", 
        "Advanced", "Upper Advanced"
    ];

    // --- Network Interceptor ---
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await originalFetch(...args);
        const url = args[0] ? args[0].toString() : '';

        if (url.includes('/sync/get/free4talk/groups')) {
            const clone = response.clone();
            clone.json().then(json => {
                if (json && json.data) {
                    Object.values(json.data).forEach(room => {
                        if (room.id) window.F4T_DB.set(room.id, room);
                    });
                    updateLaunchButton(window.F4T_DB.size);
                }
            }).catch(() => {});
        }
        return response;
    };

    // --- Logic: Statistical Scoring ---
    function calculateSmartScore(room) {
        const clients = room.clients || [];
        if (clients.length === 0) return -1;

        const scores = clients.map(c => {
            const following = c.following || 0;
            const followers = c.followers || 0;
            const friends = c.friends || 0;

            c.score = (friends + 1) / (following + followers - friends + 2);
            c.score *= 1 - 0.5 * (Math.abs(following - friends) + 1) / ((following + followers - friends) + 2);
            c.score *= 1 - 0.5 * (Math.abs(followers - friends) + 1) / ((following + followers - friends) + 2);

            return c.score;
        });

        // Geometric Mean
        const product = scores.reduce((acc, val) => acc * val, 1);
        const geoMean = Math.pow(product, 1 / scores.length);

        return Math.round(geoMean * 1000) / 100;
    }

    // --- UI Logic ---
    function openOverlay() {
        if (document.getElementById('f4t-overlay')) return;
        document.body.classList.add('f4t-focus-mode');

        const overlay = document.createElement('div');
        overlay.id = 'f4t-overlay';
        
        const levelChecksHtml = F4T_LEVELS.map(lvl => `
            <label class="f4t-chip">
                <input type="checkbox" value="${lvl}" checked class="f4t-level-cb">
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
                    <input type="text" id="f4t-lang" value="English" placeholder="Any">
                </div>
                <div class="f4t-field" style="flex:1.5">
                    <label>2nd Lang</label>
                    <input type="text" id="f4t-sec" value="" placeholder="E.g: None, Spanish">
                </div>
                <div class="f4t-field" style="flex:0.8">
                    <label>Min Slots</label>
                    <input type="number" id="f4t-slots" value="1" min="0">
                </div>
                <div class="f4t-field" style="flex:1.5">
                    <label>Sort</label>
                    <select id="f4t-sort">
                        <option value="score_desc">Score: High to Low</option>
                        <option value="score_asc">Score: Low to High</option>
                        <option value="recent">Recent</option>
                    </select>
                </div>
                
                <div class="f4t-field-btn">
                    <label class="f4t-toggle-btn">
                        <input type="checkbox" id="f4t-req-mic" checked>
                        <span>🎤 Mic Only</span>
                    </label>
                </div>
            </div>

            <div class="f4t-level-bar">
                ${levelChecksHtml}
            </div>

            <div id="f4t-grid" class="f4t-grid"></div>
        </div>
        `;

        document.body.appendChild(overlay);

        const inputs = overlay.querySelectorAll('input, select');
        inputs.forEach(el => {
            el.addEventListener('input', render);
            el.addEventListener('change', render);
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

        const search = document.getElementById('f4t-search').value.toLowerCase().trim();
        const langInput = document.getElementById('f4t-lang').value.trim();
        
        // --- Parse Second Language Input ---
        const secInputRaw = document.getElementById('f4t-sec').value;
        const secInput = secInputRaw.split(',')
            .map(s => s.trim())
            .filter(s => s !== "")
            .map(s => {
                // Map 'none' to empty string to allow filtering for rooms with NO second language
                if (s.toLowerCase() === 'none') return "";
                return s;
            });

        const minSlots = parseInt(document.getElementById('f4t-slots').value) || 0;
        const reqMic = document.getElementById('f4t-req-mic').checked;
        const sortMode = document.getElementById('f4t-sort').value;
        const selectedLevels = Array.from(document.querySelectorAll('.f4t-level-cb:checked')).map(cb => cb.value);

        const grid = document.getElementById('f4t-grid');
        const matchBadge = document.getElementById('f4t-match-count');
        const totalBadge = document.getElementById('f4t-total-count');

        let items = Array.from(window.F4T_DB.values()).map(room => ({
            ...room,
            _score: calculateSmartScore(room),
            _date: new Date(room.createdAt)
        }));

        items = items.filter(i => {
            let pass = true;
            
            // 1. Search Filter
            if (search) {
                const topicMatch = (i.topic || "").toLowerCase().includes(search);
                const userMatch = i.clients.some(c => (c.name || "").toLowerCase().includes(search));
                if (!topicMatch && !userMatch) pass = false;
            }

            // 2. Language Filter (Only if input is not empty)
            if (pass && langInput) {
                pass = (i.language === langInput);
            }

            // 3. Level Filter
            if (pass && !selectedLevels.includes(i.level)) pass = false;

            // 4. Slots Filter
            if (pass) {
                if (!i.clients || i.clients.length === 0) pass = false;
                else if (i.maxPeople > 0 && (i.maxPeople - i.clients.length < minSlots)) pass = false;
            }

            // 5. Second Language Filter (Only if input has content)
            // If input is empty string, we skip this check (disable filter)
            if (pass && secInputRaw.trim() !== "") {
                const roomSec = i.secondLanguage || "";
                pass = secInput.includes(roomSec);
            }

            // 6. Mic & Lock settings
            if (pass && reqMic && i.settings.noMic) pass = false;
            if (pass && i.settings.isLocked) pass = false;
            
            return pass;
        });

        items.sort((a, b) => {
            if (sortMode === 'score_desc') return b._score - a._score;
            if (sortMode === 'score_asc') return a._score - b._score;
            if (sortMode === 'recent') return b._date - a._date;
            return 0;
        });

        if (matchBadge) matchBadge.textContent = items.length;
        if (totalBadge) totalBadge.textContent = window.F4T_DB.size;

        if (items.length === 0) {
            grid.innerHTML = '<div class="f4t-empty">No rooms match criteria</div>';
            return;
        }

        grid.innerHTML = items.map(item => {
            const isRisky = item._score < 2.5;
            const cardClass = isRisky ? 'f4t-card-neg' : '';
            
            let scoreColor = '#66bb6a'; 
            if (item._score < 5.0) scoreColor = '#ffee58';
            if (item._score < 2.5) scoreColor = '#ff5252';

            const btnClass = isRisky ? 'f4t-btn-risky' : 'f4t-btn-safe';
            const btnText = isRisky ? '⚠️ Join' : 'Join';

            const members = item.clients.map(c => {
                const isHost = c.id === item.creator.id;
                const diff = (c.following || 0) - (c.followers || 0);
                
                let statColor = '#66bb6a';
                if (c.score < .5) statColor = '#ffb74d';
                if (c.score < .25) statColor = '#ff5252';
                
                return `
                <div class="f4t-mem">
                    <div class="f4t-ava-wrap">
                        <img src="${c.avatar}" class="f4t-ava" loading="lazy">
                        ${isHost ? '<span class="f4t-host">HOST</span>' : ''}
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
                        <div class="f4t-meta">by ${escapeHtml(item.creator.name)} • ${getTimeAgo(item._date)}</div>
                    </div>
                    <div class="f4t-score-box" style="color:${scoreColor}; border-color:${scoreColor}66;">
                        <span>${item._score.toFixed(2)}</span>
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

    function escapeHtml(t) { return t ? t.replace(/&/g, "&amp;").replace(/</g, "&lt;") : ""; }
    function getTimeAgo(d) {
        const m = Math.floor((new Date()-d)/60000);
        if(m<1) return "Now"; if(m<60) return m+"m"; 
        const h=Math.floor(m/60); return h<24 ? h+"h" : Math.floor(h/24)+"d";
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
                background: #1e1e1e; color: #66bb6a; border: 1px solid #333;
                padding: 10px 20px; border-radius: 50px; font-weight: 700;
                z-index: 9999; box-shadow: 0 4px 15px rgba(0,0,0,0.5); cursor: pointer;
                transition: 0.2s; font-family: system-ui;
            }
            #f4t-launch-btn:hover { background: #252525; transform: scale(1.05); }
            #f4t-launch-btn.pulse { border-color: #66bb6a; box-shadow: 0 0 10px #66bb6a; }

            #f4t-overlay {
                position: fixed; top: 0; left: 2%; width: 96%; height: 100%;
                background: #0a0a0a; z-index: 10000; display: flex;
                font-family: 'Segoe UI', system-ui, sans-serif;
            }
            .f4t-panel {
                width: 100%; height: 100%; display: flex; flex-direction: column;
                background: #121212;
            }

            .f4t-header {
                display: flex; align-items: center; padding: 10px 20px;
                background: #1e1e1e; border-bottom: 1px solid #333; gap: 20px;
            }
            .f4t-brand { display: flex; align-items: center; gap: 10px; min-width: max-content; }
            .f4t-brand h2 { margin: 0; color: #66bb6a; font-size: 1.4rem; }
            .f4t-counts { color: #888; font-size: 0.9rem; font-weight: bold; background: #111; padding: 3px 10px; border-radius: 6px; }
            
            .f4t-search-container { flex: 1; display: flex; }
            #f4t-search {
                width: 100%; background: #0a0a0a; border: 1px solid #333; color: #fff;
                padding: 8px 15px; border-radius: 6px; font-size: 1rem;
            }
            #f4t-search:focus { border-color: #66bb6a; outline: none; }

            #f4t-close { background: none; border: none; color: #888; font-size: 1.5rem; cursor: pointer; padding: 0 15px; }
            #f4t-close:hover { color: #ff5252; }

            .f4t-toolbar {
                display: flex; gap: 15px; padding: 12px 20px; background: #1a1a1a;
                border-bottom: 1px solid #333; align-items: flex-end; flex-wrap: wrap;
            }
            .f4t-field { display: flex; flex-direction: column; gap: 4px; min-width: 80px; flex: 1; }
            .f4t-field label { font-size: 0.75rem; color: #999; font-weight: 700; text-transform: uppercase; }
            .f4t-field input, .f4t-field select {
                height: 38px; box-sizing: border-box;
                background: #2c2c2c; border: 1px solid #444; color: #eee;
                padding: 0 12px; border-radius: 6px; font-size: 1rem; width: 100%;
            }
            .f4t-field input::placeholder { color: #666; font-style: italic; }
            
            .f4t-field-btn { display: flex; flex-direction: column; justify-content: flex-end; }
            .f4t-toggle-btn {
                height: 38px; display: flex; align-items: center; padding: 0 16px;
                background: #2a2a2a; border: 1px solid #444; border-radius: 6px;
                cursor: pointer; user-select: none; transition: 0.2s; white-space: nowrap;
            }
            .f4t-toggle-btn input { display: none; }
            .f4t-toggle-btn span { font-size: 1rem; color: #aaa; font-weight: 600; }
            .f4t-toggle-btn input:checked + span { color: #fff; }
            .f4t-toggle-btn:has(input:checked) { background: #1b3320; border-color: #66bb6a; }

            .f4t-level-bar {
                display: flex; gap: 8px; padding: 10px 20px; background: #181818;
                border-bottom: 1px solid #333; overflow-x: auto;
            }
            .f4t-chip { cursor: pointer; user-select: none; }
            .f4t-chip input { display: none; }
            .f4t-chip span {
                display: block; padding: 6px 14px; background: #222; border: 1px solid #333;
                border-radius: 50px; font-size: 0.85rem; color: #888; transition: 0.15s; white-space: nowrap;
            }
            .f4t-chip input:checked + span {
                background: #333; color: #66bb6a; border-color: #66bb6a; font-weight: bold;
            }

            .f4t-grid {
                flex: 1; overflow-y: auto; padding: 25px;
                display: grid; grid-template-columns: repeat(auto-fill, minmax(480px, 1fr));
                gap: 25px; align-content: flex-start;
            }
            .f4t-empty { width: 100%; text-align: center; margin-top: 50px; color: #444; font-size: 1.5rem; }

            .f4t-card {
                background: #1e1e1e; border: 1px solid #333; border-radius: 12px;
                display: flex; flex-direction: column; overflow: hidden; height: max-content;
                box-shadow: 0 4px 6px rgba(0,0,0,0.2);
            }
            .f4t-card:hover { border-color: #555; transform: translateY(-2px); transition: 0.2s; }
            .f4t-card-neg { border-color: #3d1a1a; }
            .f4t-card-neg:hover { border-color: #ff5252; }

            .f4t-card-head {
                padding: 15px; background: #252525; border-bottom: 1px solid #333;
                display: flex; justify-content: space-between;
            }
            .f4t-head-left { overflow: hidden; margin-right: 15px; }
            .f4t-topic { font-weight: 700; color: #eee; font-size: 1.15rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .f4t-meta { font-size: 0.85rem; color: #999; margin-top: 4px; }
            
            .f4t-score-box {
                padding: 4px 12px; border-radius: 6px; font-family: monospace; font-weight: bold;
                border: 1px solid transparent; height: fit-content; font-size: 1.1rem;
            }

            .f4t-tags { padding: 10px 15px; background: #222; display: flex; gap: 8px; flex-wrap: wrap; }
            .f4t-tag { font-size: 0.8rem; padding: 4px 10px; border-radius: 6px; color: #fff; }
            .f4t-tag-lang { background: #1565C0; }
            .f4t-tag-base { background: #444; }
            .f4t-tag-sec { background: #7B1FA2; }

            .f4t-members { max-height: 240px; overflow-y: auto; background: #1a1a1a; flex: 1; }
            .f4t-members::-webkit-scrollbar { width: 6px; }
            .f4t-members::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }

            .f4t-mem { display: flex; align-items: center; padding: 10px 15px; border-bottom: 1px solid #2a2a2a; }
            .f4t-ava-wrap { position: relative; margin-right: 15px; }
            .f4t-ava { width: 42px; height: 42px; border-radius: 50%; background: #333; border: 2px solid #333; }
            .f4t-host { position: absolute; bottom: -2px; right: -2px; background: #2196F3; color:#fff; font-size:0.6rem; padding:2px 4px; border-radius: 4px; }
            .f4t-mem-info { overflow: hidden; }
            .f4t-mem-name { font-size: 1rem; color: #eee; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
            .f4t-mem-stats { font-size: 0.8rem; font-family: monospace; }

            .f4t-footer {
                padding: 12px 15px; background: #252525; border-top: 1px solid #333;
                display: flex; justify-content: space-between; align-items: center;
            }
            .f4t-cap { font-size: 0.9rem; color: #999; font-weight: 600; }
            
            .f4t-join {
                text-decoration: none; padding: 8px 20px; border-radius: 8px;
                font-size: 0.95rem; font-weight: 700;
            }
            .f4t-btn-safe { background: #66bb6a; color: #000; }
            .f4t-btn-safe:hover { background: #81c784; }
            .f4t-btn-risky { background: #c62828; color: #fff; opacity: 0.8; }
            .f4t-btn-risky:hover { opacity: 1; }
        `;
        document.head.appendChild(style);
    }

})();