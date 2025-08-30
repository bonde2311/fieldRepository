/** @odoo-module **/

import { jsonrpc } from "@web/core/network/rpc_service";

let db = null;
let gpsIntervalId = null;
let syncIntervalId = null;
let trackingStartTime = null;
let currentTrackingSession = null;
let lastKnownPosition = null;

// Enhanced configuration for better location filtering
const LOCATION_CONFIG = {
    MIN_DISTANCE_METERS: 8,      // Minimum distance to consider as movement
    MIN_TIME_SECONDS: 25,        // Minimum time between same location points
    MAX_ACCURACY_METERS: 35,     // Maximum GPS accuracy to accept
    CLUSTER_THRESHOLD: 0.0001,   // Clustering threshold for similar locations (degrees)
    MAX_CLUSTER_POINTS: 3,       // Maximum route points to keep in a cluster
};

// Position history for enhanced filtering
let positionHistory = [];
const MAX_HISTORY_SIZE = 20;

async function getCurrentEmployeeData() {
    try {
        const res = await jsonrpc("/live/gps/get_employee_id", {});
        return res || {};
    } catch (error) {
        console.error("Failed to fetch employee/attendance ID:", error);
        return {};
    }
}

async function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open("odoo_gps_tracker", 4); // Increment version number
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
            db = req.result;
            resolve(db);
        };
        req.onupgradeneeded = (event) => {
            const db = event.target.result;
            const transaction = event.target.transaction;

            // Create object store if it doesn't exist
            let store;
            if (!db.objectStoreNames.contains("locations")) {
                store = db.createObjectStore("locations", { keyPath: "timestamp" });
            } else {
                store = transaction.objectStore("locations");
            }

            // Create indexes if they don't exist
            const indexNames = ['synced', 'tracking_type', 'employee_id', 'cluster_id'];

            indexNames.forEach(indexName => {
                if (!store.indexNames.contains(indexName)) {
                    store.createIndex(indexName, indexName, { unique: false });
                    console.log(`Created index: ${indexName}`);
                }
            });
        };
    });
}

// Calculate distance between two points using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c; // Distance in meters
}

// Enhanced cluster conflict checking with better error handling
async function checkClusterConflict(lat, lon, trackingType, employeeId) {
    if (!db) return { hasConflict: false, clusterId: null };

    // Don't cluster important tracking types
    if (['check_in', 'check_out', 'customer_check_in', 'customer_check_out'].includes(trackingType)) {
        return { hasConflict: false, clusterId: null };
    }

    return new Promise((resolve) => {
        const tx = db.transaction("locations", "readonly");
        const store = tx.objectStore("locations");

        // Check if the employee_id index exists before using it
        let request;
        if (store.indexNames.contains("employee_id")) {
            const index = store.index("employee_id");
            request = index.getAll(employeeId);
        } else {
            // Fallback: get all records and filter manually
            console.warn("employee_id index not found, using fallback method");
            request = store.getAll();
        }

        request.onsuccess = () => {
            let allLocations = request.result;

            // If we got all records, filter by employee_id
            if (!store.indexNames.contains("employee_id")) {
                allLocations = allLocations.filter(loc => loc.employee_id === employeeId);
            }

            // Find recent locations (last 2 hours) to check for clusters
            const recentThreshold = new Date(Date.now() - 2 * 60 * 60 * 1000);
            const recentLocations = allLocations.filter(loc =>
                new Date(loc.timestamp) > recentThreshold
            );

            let clusterId = null;
            let routePointsInCluster = 0;
            let hasImportantPoints = false;

            for (const location of recentLocations) {
                const distance = calculateDistance(lat, lon, location.latitude, location.longitude);

                // Check if within cluster threshold (convert degrees to approximate meters)
                if (distance <= LOCATION_CONFIG.MIN_DISTANCE_METERS) {
                    clusterId = location.cluster_id || `cluster_${location.latitude}_${location.longitude}`;

                    // Count route points in this cluster
                    if (location.tracking_type === 'route_point') {
                        routePointsInCluster++;
                    }

                    // Check for important points in cluster
                    if (['check_in', 'check_out', 'customer_check_in', 'customer_check_out'].includes(location.tracking_type)) {
                        hasImportantPoints = true;
                    }
                }
            }

            // Determine if we should skip this point
            const shouldSkip = clusterId &&
                              routePointsInCluster >= LOCATION_CONFIG.MAX_CLUSTER_POINTS &&
                              trackingType === 'route_point' &&
                              !hasImportantPoints;

            resolve({
                hasConflict: shouldSkip,
                clusterId: clusterId || `cluster_${lat}_${lon}`,
                routePointsInCluster,
                hasImportantPoints
            });
        };

        request.onerror = () => {
            console.error("Error checking cluster conflicts:", request.error);
            resolve({ hasConflict: false, clusterId: `cluster_${lat}_${lon}` });
        };
    });
}

// Enhanced location filtering with cluster analysis
async function shouldSaveLocation(lat, lon, accuracy, timestamp, trackingType = "route_point", employeeId = null) {
    // Always save important tracking types
    if (['check_in', 'check_out', 'customer_check_in', 'customer_check_out'].includes(trackingType)) {
        console.log("✅ Important tracking type - always save");
        return { shouldSave: true, clusterId: null };
    }

    // Always save the first location
    if (!lastKnownPosition) {
        return { shouldSave: true, clusterId: `cluster_${lat}_${lon}` };
    }

    // Reject low accuracy readings
    if (accuracy > LOCATION_CONFIG.MAX_ACCURACY_METERS) {
        console.log(`🎯 Rejected low accuracy GPS: ${accuracy}m`);
        return { shouldSave: false, clusterId: null };
    }

    const distance = calculateDistance(
        lastKnownPosition.lat,
        lastKnownPosition.lon,
        lat,
        lon
    );

    const timeDiff = (new Date(timestamp) - new Date(lastKnownPosition.timestamp)) / 1000;

    // Check cluster conflicts for route points
    const clusterInfo = await checkClusterConflict(lat, lon, trackingType, employeeId);

    console.log(`📏 Distance: ${distance.toFixed(2)}m, Time: ${timeDiff.toFixed(0)}s, Accuracy: ${accuracy}m`);
    console.log(`🎯 Cluster info:`, clusterInfo);

    // Skip if too many route points in cluster
    if (clusterInfo.hasConflict) {
        console.log("⏭️ Skipping - too many route points in cluster");
        return { shouldSave: false, clusterId: clusterInfo.clusterId };
    }

    // Save if moved significantly
    if (distance >= LOCATION_CONFIG.MIN_DISTANCE_METERS) {
        console.log("✅ Significant movement detected");
        return { shouldSave: true, clusterId: clusterInfo.clusterId };
    }

    // Save if enough time has passed at same location (but limit cluster points)
    if (timeDiff >= LOCATION_CONFIG.MIN_TIME_SECONDS) {
        if (clusterInfo.routePointsInCluster < LOCATION_CONFIG.MAX_CLUSTER_POINTS) {
            console.log("✅ Time threshold reached - adding to cluster");
            return { shouldSave: true, clusterId: clusterInfo.clusterId };
        } else {
            console.log("⏭️ Skipping - cluster already has enough route points");
            return { shouldSave: false, clusterId: clusterInfo.clusterId };
        }
    }

    console.log("⏭️ Skipping - insufficient movement/time");
    return { shouldSave: false, clusterId: clusterInfo.clusterId };
}

async function saveToLocal(lat, lon, employeeId, attendanceId, accuracy, taskId = null, trackingType = "route_point", comment = "") {
    if (!db) {
        console.error("❌ Database not initialized");
        return;
    }

    const timestamp = new Date().toISOString();

    // Check if we should save this location with enhanced clustering
    const saveDecision = await shouldSaveLocation(lat, lon, accuracy, timestamp, trackingType, employeeId);

    if (!saveDecision.shouldSave) {
        return Promise.resolve(); // Skip saving
    }

    const tx = db.transaction("locations", "readwrite");
    const store = tx.objectStore("locations");
    const item = {
        timestamp,
        latitude: lat,
        longitude: lon,
        employee_id: employeeId,
        attendance_id: attendanceId,
        task_id: taskId,
        tracking_type: trackingType,
        comment: comment || "",
        accuracy: accuracy,
        cluster_id: saveDecision.clusterId, // Add cluster ID
        synced: false,
    };

    store.put(item);
    console.log("📍 Saved locally:", item);

    // Update last known position
    lastKnownPosition = {
        lat,
        lon,
        timestamp,
        accuracy,
        trackingType
    };

    // Update position history
    positionHistory.push({
        lat, lon, accuracy, timestamp, trackingType,
        time: new Date(timestamp)
    });

    // Keep history manageable
    if (positionHistory.length > MAX_HISTORY_SIZE) {
        positionHistory = positionHistory.slice(-MAX_HISTORY_SIZE);
    }

    return tx.complete;
}

async function syncWithServer() {
    if (!db) await openDB();

    const tx = db.transaction("locations", "readwrite");
    const store = tx.objectStore("locations");
    const unsynced = [];

    await new Promise((resolve) => {
        store.openCursor().onsuccess = function (event) {
            const cursor = event.target.result;
            if (cursor) {
                const item = cursor.value;
                const itemTime = new Date(item.timestamp);

                if (!item.synced && (!trackingStartTime || itemTime >= trackingStartTime)) {
                    unsynced.push({ key: cursor.key, data: item });
                }
                cursor.continue();
            } else {
                resolve();
            }
        };
    });

    console.log(`🔄 Syncing ${unsynced.length} unsynced items`);

    for (const item of unsynced) {
        try {
            const res = await fetch("/live/gps/update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    method: "call",
                    params: item.data,
                }),
            });

            const response = await res.json();

            if (response.result?.status === "ok" || response.result?.status === "duplicate") {
                const updateTx = db.transaction("locations", "readwrite");
                const updateStore = updateTx.objectStore("locations");
                item.data.synced = true;
                updateStore.put(item.data);
                console.log("✅ Synced:", item.data);
            } else {
                console.warn("⚠️ Unexpected response:", response);
            }
        } catch (e) {
            console.warn("❌ Sync error (maybe offline):", e);
        }
    }
}

// Enhanced global tracker object
window.odoo = window.odoo || {};
window.odoo.gpsTracker = {
    startGPSTracking: async function (employeeId = null, attendanceId = null, taskId = null, trackingType = "route_point", comment = "") {
        try {
            const empData = await getCurrentEmployeeData();

            if (empData.status === "disabled") {
                console.log("GPS tracking is disabled for this user");
                return false;
            }

            if (empData.status === "error") {
                console.error("Error getting employee data:", empData.error);
                return false;
            }

            employeeId = employeeId || empData.employee_id;
            attendanceId = attendanceId || empData.attendance_id;

            if (!employeeId || !attendanceId) {
                console.error("❌ Required employee or attendance ID missing.");
                return false;
            }

            await openDB();

            currentTrackingSession = {
                employeeId,
                attendanceId,
                taskId,
                trackingType,
                comment: comment || "",
                startTime: new Date()
            };

            trackingStartTime = new Date();
            lastKnownPosition = null;
            positionHistory = []; // Reset position history

            // Clear previous intervals
            if (gpsIntervalId) clearInterval(gpsIntervalId);
            if (syncIntervalId) clearInterval(syncIntervalId);

            // Start GPS collection with enhanced clustering
            gpsIntervalId = setInterval(() => {
                navigator.geolocation.getCurrentPosition(
                    async (pos) => {
                        const lat = pos.coords.latitude;
                        const lon = pos.coords.longitude;
                        const accuracy = pos.coords.accuracy;

                        console.log("📡 GPS:", lat, lon, `accuracy: ${accuracy}m`);
                        await saveToLocal(lat, lon, employeeId, attendanceId, accuracy, taskId, trackingType, comment);
                    },
                    (err) => {
                        console.error("❌ GPS Error:", err.message);
                    },
                    {
                        enableHighAccuracy: true,
                        maximumAge: 5000,
                        timeout: 10000,
                    }
                );
            }, 10000);

            // Start sync interval
            syncIntervalId = setInterval(async () => {
                await syncWithServer();
            }, 30000);

            console.log("▶️ Started GPS tracking with smart clustering");
            console.log("📊 Filter config:", LOCATION_CONFIG);
            if (comment) {
                console.log("💬 Session comment:", comment);
            }

            return true;

        } catch (error) {
            console.error("❌ Failed to start GPS tracking:", error);
            return false;
        }
    },

    stopGPSTracking: async function () {
        try {
            if (gpsIntervalId) clearInterval(gpsIntervalId);
            if (syncIntervalId) clearInterval(syncIntervalId);

            console.log("⏹️ Stopped GPS tracking for session:", currentTrackingSession);

            currentTrackingSession = null;
            trackingStartTime = null;
            lastKnownPosition = null;
            positionHistory = []; // Clear position history

            await openDB();
            await syncWithServer();

            return true;

        } catch (error) {
            console.error("❌ Failed to stop GPS tracking:", error);
            return false;
        }
    },

    // Enhanced method to add manual tracking point with smart clustering
    addTrackingPoint: async function (comment = "", trackingType = "route_point") {
        if (!this.isTrackingActive()) {
            console.warn("⚠️ GPS tracking is not active");
            return false;
        }

        return new Promise((resolve) => {
            navigator.geolocation.getCurrentPosition(
                async (pos) => {
                    const lat = pos.coords.latitude;
                    const lon = pos.coords.longitude;
                    const accuracy = pos.coords.accuracy;

                    const session = this.getCurrentSession();
                    if (session) {
                        await saveToLocal(
                            lat,
                            lon,
                            session.employeeId,
                            session.attendanceId,
                            accuracy,
                            session.taskId,
                            trackingType,
                            comment
                        );
                        console.log(`📍 Added manual tracking point with comment: "${comment}"`);
                        resolve(true);
                    } else {
                        console.error("❌ No active tracking session");
                        resolve(false);
                    }
                },
                (error) => {
                    console.error("❌ Failed to get location for manual point:", error);
                    resolve(false);
                },
                {
                    enableHighAccuracy: true,
                    maximumAge: 5000,
                    timeout: 10000,
                }
            );
        });
    },

    isTrackingActive: function () {
        return gpsIntervalId !== null;
    },

    getCurrentSession: function () {
        return currentTrackingSession;
    },

    getLastPosition: function () {
        return lastKnownPosition;
    },

    getPositionHistory: function () {
        return [...positionHistory];
    },

    syncNow: async function () {
        try {
            await openDB();
            await syncWithServer();
            console.log("🔄 Manual sync completed");
            return true;
        } catch (error) {
            console.error("❌ Manual sync failed:", error);
            return false;
        }
    },

    isGpsTrackingEnabled: async function() {
        try {
            const empData = await getCurrentEmployeeData();
            return empData.status === "ok";
        } catch (error) {
            console.error("Failed to check GPS tracking status:", error);
            return false;
        }
    },

    // Enhanced configuration methods
    setMinDistance: function(meters) {
        LOCATION_CONFIG.MIN_DISTANCE_METERS = meters;
        console.log(`📏 Min distance set to ${meters}m`);
    },

    setMinTime: function(seconds) {
        LOCATION_CONFIG.MIN_TIME_SECONDS = seconds;
        console.log(`⏱️ Min time set to ${seconds}s`);
    },

    setMaxAccuracy: function(meters) {
        LOCATION_CONFIG.MAX_ACCURACY_METERS = meters;
        console.log(`🎯 Max accuracy set to ${meters}m`);
    },

    setMaxClusterPoints: function(count) {
        LOCATION_CONFIG.MAX_CLUSTER_POINTS = count;
        console.log(`🎯 Max cluster points set to ${count}`);
    },

    getConfig: function() {
        return { ...LOCATION_CONFIG };
    },

    // Method to analyze local storage clusters with better error handling
    analyzeLocalClusters: async function() {
        if (!db) await openDB();

        return new Promise((resolve) => {
            const tx = db.transaction("locations", "readonly");
            const store = tx.objectStore("locations");

            store.getAll().onsuccess = (event) => {
                const allLocations = event.target.result;
                const clusters = {};

                allLocations.forEach(loc => {
                    const clusterId = loc.cluster_id || 'no_cluster';
                    if (!clusters[clusterId]) {
                        clusters[clusterId] = [];
                    }
                    clusters[clusterId].push(loc);
                });

                const analysis = Object.entries(clusters).map(([id, points]) => ({
                    clusterId: id,
                    pointCount: points.length,
                    trackingTypes: [...new Set(points.map(p => p.tracking_type))],
                    hasImportantPoints: points.some(p =>
                        ['check_in', 'check_out', 'customer_check_in', 'customer_check_out'].includes(p.tracking_type)
                    ),
                    routePointCount: points.filter(p => p.tracking_type === 'route_point').length
                }));

                resolve(analysis);
            };

            store.getAll().onerror = (event) => {
                console.error("Error analyzing clusters:", event.target.error);
                resolve([]);
            };
        });
    },

    autoRestoreTracking: async function () {
        try {
            if (this.isTrackingActive()) {
                console.log("GPS tracking already active, skipping auto-restore");
                return;
            }

            const empData = await getCurrentEmployeeData();

            if (empData.employee_id && empData.attendance_id) {
                console.log("Found active attendance session, restoring GPS tracking...");

                const success = await this.startGPSTracking(
                    empData.employee_id,
                    empData.attendance_id,
                    null,
                    "route_point",
                    ""
                );

                if (success) {
                    console.log("GPS tracking auto-restored successfully");
                } else {
                    console.warn("Failed to auto-restore GPS tracking");
                }
            } else {
                console.log("No active attendance session found, skipping auto-restore");
            }
        } catch (error) {
            console.error("Error in auto-restore GPS tracking:", error);
        }
    },

    // Utility method to clear database and reset (for debugging)
    resetDatabase: async function() {
        try {
            if (db) {
                db.close();
                db = null;
            }

            // Delete the database
            const deleteReq = indexedDB.deleteDatabase("odoo_gps_tracker");
            await new Promise((resolve, reject) => {
                deleteReq.onsuccess = () => resolve();
                deleteReq.onerror = () => reject(deleteReq.error);
            });

            // Reinitialize
            await openDB();
            console.log("🔄 Database reset successfully");
            return true;
        } catch (error) {
            console.error("❌ Failed to reset database:", error);
            return false;
        }
    }
};

// Enhanced debug helper
window.odoo.gpsTracker.getStatus = function () {
    return {
        isActive: this.isTrackingActive(),
        currentSession: this.getCurrentSession(),
        trackingStartTime: trackingStartTime,
        lastPosition: lastKnownPosition,
        positionHistoryCount: positionHistory.length,
        config: LOCATION_CONFIG,
        databaseVersion: db ? db.version : 'not_initialized'
    };
};

// Background sync triggers
window.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible") {
        console.log("👁️ Page visible - sync triggered");
        await openDB();
        await syncWithServer();
    }
});

window.addEventListener("beforeunload", async () => {
    if (window.odoo.gpsTracker.isTrackingActive()) {
        console.log("🚪 Page unload - final sync");
        await syncWithServer();
    }
});

window.addEventListener("load", async () => {
    console.log("🔄 Page loaded - checking for active attendance session");
    await window.odoo.gpsTracker.autoRestoreTracking();
});

console.log("🚀 Enhanced GPS Tracker with smart clustering initialized");