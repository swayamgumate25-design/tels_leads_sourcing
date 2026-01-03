/**
 * script.js
 * Handles form submission, API calls to n8n, UI state management, and file exports.
 */

// ================= CONSTANTS =================
// Placeholder Webhook URLs - REPLACED BY USER
const SHEET_WEBHOOK = "https://telsleadsfinders.vercel.app/";
const REDROB_WEBHOOK = "YOUR_REDROB_WEBHOOK_URL_HERE";

// Store current results to facilitate downloads
let currentData = [];
// Store cached file payload (for persistence across refreshes)
let cachedFilePayload = null;

// ================= DOM ELEMENTS =================
const searchForm = document.getElementById('searchForm');
const searchBtn = document.getElementById('searchBtn');
const resultsSection = document.getElementById('resultsSection');
const resultsTableBody = document.querySelector('#resultsTable tbody');
const noDataSection = document.getElementById('noDataSection');
const redrobSearchBtn = document.getElementById('redrobSearchBtn');
const notificationContainer = document.getElementById('notificationContainer');
const loadingState = document.getElementById('loadingState');

// File Upload Elements
const fileUploadWrapper = document.getElementById('fileUploadWrapper');
const fileInput = document.getElementById('fileInput');
const fileLabelText = document.getElementById('fileLabelText');
const fileNameDisplay = document.getElementById('fileName');
const removeFileBtn = document.getElementById('removeFileBtn');
const fileIcon = document.querySelector('.file-icon');
const fileSuccessIcon = document.querySelector('.file-success-icon');

// ================= EVENT LISTENERS =================

// Handle main form submission
searchForm.addEventListener('submit', handleSearch);

// Handle "Search on Redrob" button click
redrobSearchBtn.addEventListener('click', handleRedrobSearch);

// File Upload Interaction
fileUploadWrapper.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', handleFileSelect);
removeFileBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent triggering wrapper click
    removeFile();
});

// Drag and Drop support
fileUploadWrapper.addEventListener('dragover', (e) => {
    e.preventDefault();
    fileUploadWrapper.classList.add('active');
});

fileUploadWrapper.addEventListener('dragleave', () => {
    fileUploadWrapper.classList.remove('active');
});

fileUploadWrapper.addEventListener('drop', (e) => {
    e.preventDefault();
    fileUploadWrapper.classList.remove('active');

    if (e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        handleFileSelect();
    }
});

// Initialize Persistence
window.addEventListener('load', loadFileFromStorage);

// ================= FUNCTIONS =================

/**
 * Handles the initial search form submission
 * @param {Event} e 
 */
async function handleSearch(e) {
    e.preventDefault();

    // Get form values
    const name = document.getElementById('name').value;
    const location = document.getElementById('location').value;
    const technology = document.getElementById('technology').value;

    // Check for file
    let filePayload = {};
    if (fileInput.files.length > 0) {
        // Option A: New file selected by user
        try {
            const file = fileInput.files[0];
            const base64 = await toBase64(file);
            filePayload = {
                fileData: base64,
                fileName: file.name,
                fileMimeType: file.type
            };

            // Allow persistence for next time (even though handleFileSelect does it, 
            // doing it here ensures we have the latest if something changed)
            saveFileToStorage(filePayload);

            console.log("File attached (New):", file.name);
        } catch (err) {
            console.error("File processing error:", err);
            showNotification("Failed to process file", "error");
            return;
        }
    } else if (cachedFilePayload) {
        // Option B: Use cached file from previous session/refresh
        filePayload = cachedFilePayload;
        console.log("File attached (Cached):", filePayload.fileName);
    }

    const payload = { ...{ name, location, technology }, ...filePayload };

    // Validation: Ensure at least one criteria is provided
    if (!name && !location && !technology && !payload.fileData) {
        showNotification("Please enter at least one search criteria or upload a file.", "error");
        return;
    }

    console.log("Searching with payload:", payload);

    // --- NEW: WEBHOOK SUBMISSION (FormData) ---
    try {
        const formData = new FormData();
        formData.append('name', name);
        formData.append('location', location);
        formData.append('technology', technology);

        if (fileInput.files.length > 0) {
            formData.append('file', fileInput.files[0]);
        }

        // Send to new webhook (silently, fire and forget)
        fetch("https://technoedge.app.n8n.cloud/webhook-test/tels-leads", {
            method: "POST",
            body: formData
        });

    } catch (err) {
        console.warn("Webhook preparation error:", err);
    }
    // ------------------------------------------

    // Reset UI
    resetUI();
    showLoading();

    try {
        let data = [];

        // LOGIC: Use Local File if present, otherwise use Primary Webhook (legacy)
        if (payload.fileData) {
            // Local Search Mode
            const fileType = payload.fileMimeType || '';
            const isExcelOrCsv = fileType.includes('sheet') || fileType.includes('excel') || fileType.includes('csv') || payload.fileName.endsWith('.csv') || payload.fileName.endsWith('.xlsx');

            if (isExcelOrCsv) {
                data = await processLocalFile(payload.fileData, { name, location, technology });
            } else {
                data = await searchData(SHEET_WEBHOOK, payload);
            }
        } else {
            // No file -> Use Primary Webhook (Vercel)
            data = await searchData(SHEET_WEBHOOK, payload);
        }

        hideLoading();

        if (data && data.length > 0) {
            renderTable(data);
        } else {
            showNoData();
        }

    } catch (error) {
        hideLoading();
        console.error("Search failed:", error);
        showNotification("An error occurred while searching.", "error");
    }
}

/**
 * Handles the secondary Redrob search
 */
async function handleRedrobSearch() {
    // Get values again (they are still in the form)
    const name = document.getElementById('name').value;
    const location = document.getElementById('location').value;
    const technology = document.getElementById('technology').value;

    const payload = { name, location, technology };

    // Update UI
    noDataSection.classList.add('hidden');
    showLoading();

    try {
        // Call the Secondary Webhook
        const data = await searchData(REDROB_WEBHOOK, payload);

        hideLoading();

        if (data && data.length > 0) {
            renderTable(data);
        } else {
            showNotification("No data found on Redrob either.", "error");
            showNoData();
            document.querySelector('.no-data-content h3').innerText = "Still no results";
            document.querySelector('.no-data-content p').innerText = "We checked Redrob too, but found nothing.";
            redrobSearchBtn.classList.add('hidden');
        }

    } catch (error) {
        hideLoading();
        console.error("Redrob search failed:", error);

        if (REDROB_WEBHOOK === "YOUR_REDROB_WEBHOOK_URL_HERE") {
            showNotification("Error: Please replace Redrob Webhook URL in script.js.", "error");
        } else {
            showNotification("Failed to search Redrob.", "error");
        }
    }
}

/**
 * Generic function to POST data to a webhook
 * @param {string} url - The n8n webhook URL
 * @param {object} payload - The JSON payload
 * @returns {Promise<Array>} - The array of results
 */
async function searchData(url, payload) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data;
    // Assumes n8n returns an array of objects e.g. [{name, location, technology, email, phone}, ...]
}

/**
 * Renders the data into the HTML table
 * @param {Array} data 
 */
function renderTable(data) {
    currentData = data; // Store for export
    resultsTableBody.innerHTML = ''; // Clear previous

    data.forEach(row => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(row.name || '-')}</td>
            <td>${escapeHtml(row.location || '-')}</td>
            <td>${escapeHtml(row.technology || '-')}</td>
            <td>${escapeHtml(row.email || '-')}</td>
            <td>${escapeHtml(row.phone || '-')}</td>
        `;
        resultsTableBody.appendChild(tr);
    });

    resultsSection.classList.remove('hidden');
    // Scroll to results
    resultsSection.scrollIntoView({ behavior: 'smooth' });
}

/**
 * Shows the loading spinner and state
 */
function showLoading() {
    searchBtn.disabled = true;
    searchBtn.querySelector('.btn-text').textContent = 'Searching...';
    searchBtn.querySelector('.btn-icon').classList.add('hidden');
    searchBtn.querySelector('.spinner').classList.remove('hidden');

    // Optional: Show full overlay loading state if desired, 
    // but button state might be enough. 
    // The requirement said "Show a 'Searching...' animation".
    // We already have a logic for this in the button, but let's show the big one too for clarity
    // if the previous results are hidden.
    if (resultsSection.classList.contains('hidden')) {
        loadingState.classList.remove('hidden');
    }
}

/**
 * Hides the loading spinner and state
 */
function hideLoading() {
    searchBtn.disabled = false;
    searchBtn.querySelector('.btn-text').textContent = 'Search';
    searchBtn.querySelector('.btn-icon').classList.remove('hidden');
    searchBtn.querySelector('.spinner').classList.add('hidden');

    loadingState.classList.add('hidden');
}

/**
 * Shows the "No Data" section with Redrob option
 */
function showNoData() {
    // Reset the text just in case it was changed by secondary search failure
    document.querySelector('.no-data-content h3').innerText = "No matching leads found";
    document.querySelector('.no-data-content p').innerText = "We couldn't find any results in our sheets or your uploaded file.";
    redrobSearchBtn.classList.remove('hidden');

    noDataSection.classList.remove('hidden');
}

/**
 * Resets the UI (hides results, no-data, etc.)
 */
function resetUI() {
    resultsSection.classList.add('hidden');
    noDataSection.classList.add('hidden');
    currentData = [];
}

/**
 * Shows a toast notification
 * @param {string} message 
 * @param {string} type - 'error' or 'success'
 */
function showNotification(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <i class="fa-solid ${type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'}"></i>
        <span>${message}</span>
    `;

    notificationContainer.appendChild(toast);

    // Remove after 3 seconds
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

/**
 * Security helper to prevent XSS
 */
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Handles file selection event
 */
async function handleFileSelect() {
    if (fileInput.files.length > 0) {
        const file = fileInput.files[0];

        // Update UI
        updateFileUI(file.name);

        // Persist
        try {
            const base64 = await toBase64(file);
            const payload = {
                fileData: base64,
                fileName: file.name,
                fileMimeType: file.type
            };
            saveFileToStorage(payload);
        } catch (e) {
            console.warn("Could not save file to storage (likely too big):", e);
        }
    }
}

/**
 * Clears the selected file
 */
function removeFile() {
    fileInput.value = ''; // clear input
    cachedFilePayload = null;
    clearFileStorage();

    // Reset UI
    fileLabelText.textContent = "Click or Drag to Upload PDF, CSV, Excel";
    fileNameDisplay.textContent = '';
    fileNameDisplay.classList.add('hidden');

    fileIcon.classList.remove('hidden');
    fileSuccessIcon.classList.add('hidden');

    fileUploadWrapper.classList.remove('active');
    removeFileBtn.classList.add('hidden');
}

/**
 * Updates UI to show selected file
 */
function updateFileUI(fileName) {
    fileLabelText.textContent = "File Selected";
    fileNameDisplay.textContent = fileName;
    fileNameDisplay.classList.remove('hidden');

    fileIcon.classList.add('hidden');
    fileSuccessIcon.classList.remove('hidden');

    fileUploadWrapper.classList.add('active');
    removeFileBtn.classList.remove('hidden');
}

// ================= STORAGE =================

function saveFileToStorage(payload) {
    try {
        sessionStorage.setItem('leads_file_payload', JSON.stringify(payload));
        cachedFilePayload = payload;
    } catch (e) {
        console.warn("SessionStorage Error (Quota exceeded?):", e);
        showNotification("File too large to save for refresh, but search will work.", "error");
    }
}

function loadFileFromStorage() {
    try {
        const saved = sessionStorage.getItem('leads_file_payload');
        if (saved) {
            cachedFilePayload = JSON.parse(saved);
            updateFileUI(cachedFilePayload.fileName);
            console.log("Restored file from storage:", cachedFilePayload.fileName);
        }
    } catch (e) {
        console.error("Error loading from storage:", e);
    }
}

function clearFileStorage() {
    sessionStorage.removeItem('leads_file_payload');
}

/**
 * Converts a file to Base64 string
 * @param {File} file 
 * @returns {Promise<string>}
 */
function toBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
    });
}

/**
 * Processes a local file (Excel/CSV) and filters data based on criteria
 * @param {string} base64Data 
 * @param {object} criteria {name, location, technology}
 * @returns {Promise<Array>}
 */
async function processLocalFile(base64Data, criteria) {
    return new Promise((resolve, reject) => {
        try {
            // Parse Base64 to Workbook
            // SheetJS can read base64 directly with type: 'base64'
            // But our base64 string might have the data prefix "data:application/vnd...;base64,"
            // We need to strip that.
            const cleanBase64 = base64Data.split(',')[1] || base64Data;

            const workbook = XLSX.read(cleanBase64, { type: 'base64' });

            // Assume data is in the first sheet
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];

            // Convert to JSON
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: "" }); // defval ensures empty cells are strings

            // Normalize keys to lowercase for consistent search
            // (Assumes existing headers like Name, Location, etc.)
            // We'll try to fuzzy match headers or just assume standard ones? 
            // Let's assume the user's file might have 'Name', 'Location' etc.

            // Filter Data
            const results = jsonData.filter(row => {
                // Helper to safely get value from any likely key
                const getValue = (keyPrefix) => {
                    const key = Object.keys(row).find(k => k.toLowerCase().includes(keyPrefix));
                    return key ? String(row[key]).toLowerCase() : "";
                };

                const rowName = getValue('name');
                const rowLocation = getValue('location'); // or 'city', 'country'
                const rowTech = getValue('tech') || getValue('skill');

                // Criteria (case insensitive)
                const searchName = (criteria.name || "").toLowerCase();
                const searchLocation = (criteria.location || "").toLowerCase();
                const searchTech = (criteria.technology || "").toLowerCase();

                // Logic: MATCH inputs if they exist.
                // If a criteria is EMPTY, it acts as a wildcard (matches anything).
                // But at least one criteria MUST match (validated earlier).

                const matchName = !searchName || rowName.includes(searchName);
                const matchLocation = !searchLocation || rowLocation.includes(searchLocation);
                const matchTech = !searchTech || rowTech.includes(searchTech);

                return matchName && matchLocation && matchTech;
            });

            // Map results to standard format for renderTable
            const mappedResults = results.map(row => {
                // Try to resolve standard fields
                const findVal = (keyPart) => {
                    const key = Object.keys(row).find(k => k.toLowerCase().includes(keyPart));
                    return row[key] || '';
                };

                return {
                    name: findVal('name'),
                    location: findVal('location') || findVal('city'),
                    technology: findVal('tech') || findVal('skill'),
                    email: findVal('email') || findVal('mail'),
                    phone: findVal('phone') || findVal('mobile') || findVal('contact')
                };
            });

            resolve(mappedResults);

        } catch (e) {
            reject(e);
        }
    });
}

// ================= EXPORT FUNCTIONS =================

function downloadCSV() {
    if (!currentData.length) return;

    // Convert data to CSV string
    const headers = Object.keys(currentData[0]).join(','); // Assumes all objects have same keys
    // Better safely map specific fields to ensure order
    const fields = ['name', 'location', 'technology', 'email', 'phone'];

    const csvRows = [];
    csvRows.push(fields.join(',')); // Header row

    for (const row of currentData) {
        const values = fields.map(field => {
            const val = row[field] || '';
            // Escape quotes and wrap in quotes to handle commas in data
            return `"${String(val).replace(/"/g, '""')}"`;
        });
        csvRows.push(values.join(','));
    }

    const csvString = csvRows.join('\n');
    const blob = new Blob([csvString], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `leads_export_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
    showNotification("CSV Downloaded");
}

function downloadExcel() {
    if (!currentData.length) return;

    // Use SheetJS (XLSX)
    const worksheet = XLSX.utils.json_to_sheet(currentData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Leads");

    XLSX.writeFile(workbook, `leads_export_${new Date().toISOString().slice(0, 10)}.xlsx`);
    showNotification("Excel Downloaded");
}

function downloadPDF() {
    if (!currentData.length) return;

    // Use jsPDF + AutoTable
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    doc.text("Leads Search Results", 14, 20);

    const tableData = currentData.map(row => [
        row.name,
        row.location,
        row.technology,
        row.email,
        row.phone
    ]);

    doc.autoTable({
        head: [['Name', 'Location', 'Technology', 'Email', 'Phone']],
        body: tableData,
        startY: 30,
    });

    doc.save(`leads_export_${new Date().toISOString().slice(0, 10)}.pdf`);
    showNotification("PDF Downloaded");
}


