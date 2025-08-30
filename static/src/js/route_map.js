/** @odoo-module **/

import { Component, useRef, onMounted, onWillUnmount, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { jsonrpc } from "@web/core/network/rpc_service";
import { session } from "@web/session";

class GpsTrackingMap extends Component {
    setup() {
        this.mapRef = useRef("map");
        this.state = useState({
            date: new Date().toISOString().split("T")[0],
            employeeId: session.is_system ? null : session.user_id.employee_id,
            isAdmin: session.is_system,
            loading: true,
            info: null,
            employees: [],
            isLiveMode: false,
            liveUpdateInterval: null,
        });

        onMounted(async () => {
            await this.loadEmployeeData();
            await this.renderMap();
        });

        onWillUnmount(() => {
            if (this.state.liveUpdateInterval) {
                clearInterval(this.state.liveUpdateInterval);
            }
        });
    }

    async startLiveTracking() {
        if (this.state.liveUpdateInterval) {
            clearInterval(this.state.liveUpdateInterval);
        }

        this.state.isLiveMode = true;
        console.log("Starting live GPS tracking...");

        await this.loadLiveData();

        this.state.liveUpdateInterval = setInterval(async () => {
            await this.loadLiveData();
        }, 10000);

        this.env.services.notification.add("Live tracking started! Map will update every 10 seconds.", { type: 'success' });
    }

    stopLiveTracking() {
        if (this.state.liveUpdateInterval) {
            clearInterval(this.state.liveUpdateInterval);
            this.state.liveUpdateInterval = null;
        }
        this.state.isLiveMode = false;
        console.log("Stopped live GPS tracking");
        this.env.services.notification.add("Live tracking stopped.", { type: 'info' });
    }

    async loadLiveData() {
        try {
            const { employeeId } = this.state;
            const gpsDataResp = await jsonrpc("/live/gps/live_path", { employee_id: employeeId });

            if (gpsDataResp.error) {
                console.warn("Live tracking error:", gpsDataResp.error);
                this.stopLiveTracking();
                return;
            }

            const gpsData = gpsDataResp.points || [];

            // PRESERVE existing info and only update live-specific data
            this.state.info = {
                ...this.state.info,
                total_points: gpsDataResp.total_points,
                current_duration: gpsDataResp.current_duration,
                check_in_time: gpsDataResp.check_in_time,
                total_traveled_distance_km: gpsDataResp.total_traveled_distance_km,
                traveled_duration: gpsDataResp.traveled_duration, // NEW: Include traveled duration
                is_live: true,
            };

            // NEW: Handle expected duration for live tracking
            console.log("🔍 Live tracking duration data:", {
                expected_duration: gpsDataResp.expected_duration,
                current_duration: gpsDataResp.current_duration
            });

            if (gpsDataResp.expected_duration) {
                const totalSeconds = Math.floor(gpsDataResp.expected_duration);
                const hours = Math.floor(totalSeconds / 3600);
                const minutes = Math.floor((totalSeconds % 3600) / 60);
                const seconds = totalSeconds % 60;
                this.state.info.expected_duration = [
                    hours.toString().padStart(2, '0'),
                    minutes.toString().padStart(2, '0'),
                    seconds.toString().padStart(2, '0')
                ].join(':');
                console.log("✅ Set live expected_duration:", this.state.info.expected_duration);
            } else {
                console.log("⚠️ No live duration data available");
            }

            await this.updateMapWithLiveData(gpsData);

        } catch (error) {
            console.error("Error loading live data:", error);
        }
    }

    async updateMapWithLiveData(data) {
        const container = this.mapRef.el;
        if (!container || !window.google || !window.google.maps) return;

        if (!data || data.length < 1) {
            console.log("No live GPS data available yet");
            return;
        }

        container.innerHTML = "";
        await this.initMap(container, data, true);
    }

    async loadEmployeeData() {
        const { date, employeeId } = this.state;

        try {
            const res = await jsonrpc("/live/gps/employees_data", {
                date_str: date,
                employee_id: parseInt(employeeId),
            });

            if (res.error) {
                console.error("Failed to load employee data", res.error);
                if (res.error.includes("GPS tracking is disabled")) {
                    this.state.info = {
                        error: res.error,
                        gps_disabled: true
                    };
                }
                return;
            }

            const hoursResp = await jsonrpc("/live/gps/work_rest_hours", {
                employee_id: parseInt(employeeId),
                date_str: date,
            });

            console.log("Work/Rest Hours API response:", hoursResp);

            this.state.employees = res.employees || [];
            this.state.info = res.employee_info || {};

            if (this.state.info) {
                this.state.info = {
                    ...this.state.info,
                    work_hours: hoursResp.work_hours || 0,
                    rest_hours: hoursResp.rest_hours || 0,
                };
            } else {
                this.state.info = {
                    work_hours: hoursResp.work_hours || 0,
                    rest_hours: hoursResp.rest_hours || 0,
                };
            }

            console.log("Final state.info after loading:", this.state.info);

            if (!this.state.employeeId && res.employee_info?.id) {
                this.state.employeeId = res.employee_info.id;
            }

        } catch (error) {
            console.error("Error loading employee data:", error);
        }
    }

    // Enhanced clustering: always preserve important points (check-in/check-out/customer check-in/out) in clusters
    smartClusterAndFilter(data, threshold = 0.0001) {
        if (!data || data.length <= 1) return data;

        const filtered = [];
        const clusters = this.findClusters(data, threshold);

        clusters.forEach(cluster => {
            if (cluster.length === 1) {
                // Single point, keep it
                filtered.push(data[cluster[0]]);
            } else {
                // Multiple points in cluster
                const clusterPoints = cluster.map(idx => data[idx]);

                // Always keep all important points (check_in, check_out, customer_check_in, customer_check_out)
                const importantPoints = clusterPoints.filter(p =>
                    p.tracking_type === 'check_in' ||
                    p.tracking_type === 'check_out' ||
                    p.tracking_type === 'customer_check_in' ||
                    p.tracking_type === 'customer_check_out'
                );

                // Also keep points with comments (but don't let them overwrite important points)
                const commentPoints = clusterPoints.filter(p => p.comment && !importantPoints.includes(p));

                // For route_points, only keep those that are not at the same timestamp as an important point
                // and not at the same timestamp as a comment point
                const importantTimestamps = new Set(importantPoints.map(p => p.timestamp));
                const commentTimestamps = new Set(commentPoints.map(p => p.timestamp));
                const routePoints = clusterPoints.filter(p =>
                    p.tracking_type === 'route_point' &&
                    !importantTimestamps.has(p.timestamp) &&
                    !commentTimestamps.has(p.timestamp)
                );

                // Only keep the first route_point (chronologically) if there are no important or comment points
                let routeToKeep = [];
                if (importantPoints.length === 0 && commentPoints.length === 0 && routePoints.length > 0) {
                    const sortedRoute = routePoints.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                    routeToKeep = [sortedRoute[0]];
                }

                // Add all important points, then comment points, then (if needed) a route point
                filtered.push(...importantPoints, ...commentPoints, ...routeToKeep);
            }
        });

        // Sort by timestamp to maintain chronological order
        return filtered.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }

    // Helper method to find clusters of nearby points
    findClusters(data, threshold) {
        const clusters = [];
        const processed = new Set();

        data.forEach((point, index) => {
            if (processed.has(index)) return;

            const cluster = [index];
            processed.add(index);

            // Find nearby points
            for (let i = index + 1; i < data.length; i++) {
                if (processed.has(i)) continue;

                const distance = this.calculateDistance(
                    data[index].lat, data[index].lng,
                    data[i].lat, data[i].lng
                );

                if (distance <= threshold) {
                    cluster.push(i);
                    processed.add(i);
                }
            }

            clusters.push(cluster);
        });

        return clusters;
    }

    // Calculate distance between two points (Haversine formula)
    calculateDistance(lat1, lng1, lat2, lng2) {
        const R = 6371e3; // Earth's radius in meters
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lng2 - lng1) * Math.PI / 180;

        const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                  Math.cos(φ1) * Math.cos(φ2) *
                  Math.sin(Δλ/2) * Math.sin(Δλ/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

        return R * c;
    }

    // NEW: Calculate actual traveled distance from raw GPS data
    calculateActualTraveledDistanceFromRawData(rawData) {
        if (!rawData || rawData.length < 2) return 0;

        let totalDistance = 0;
        // Sort by timestamp to ensure proper order
        const sortedData = rawData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        for (let i = 1; i < sortedData.length; i++) {
            const dist = this.calculateDistance(
                sortedData[i-1].lat, sortedData[i-1].lng,
                sortedData[i].lat, sortedData[i].lng
            );
            totalDistance += dist;
        }

        return totalDistance;
    }

    // Format distance for display
    formatDistance(meters) {
        if (meters < 1000) {
            return `${Math.round(meters)} m`;
        } else {
            return `${(meters / 1000).toFixed(2)} km`;
        }
    }

    async renderMap() {
        const container = this.mapRef.el;
        if (!container) return;

        this.state.loading = true;

        const { date, employeeId, isAdmin } = this.state;
        if (isAdmin && !employeeId) {
            this.state.loading = false;
            return;
        }

        // Check if GPS tracking is disabled
        if (this.state.info?.gps_disabled) {
            this.state.loading = false;
            container.innerHTML = `
                <div style="display: flex; justify-content: center; align-items: center; height: 400px; background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px;">
                    <div style="text-align: center; color: #6c757d;">
                        <h4>GPS Tracking Disabled</h4>
                        <p>${this.state.info.error}</p>
                        <p>Please contact your administrator to enable GPS tracking.</p>
                    </div>
                </div>
            `;
            return;
        }

        const [apiKey, gpsDataResp] = await Promise.all([
            jsonrpc("/get/google/maps/api/key", {}),
            jsonrpc("/live/gps/path", { date_str: date, employee_id: employeeId }),
        ]);

        this.state.loading = false;

        // Handle GPS tracking disabled errors
        if (apiKey.error && apiKey.error.includes("GPS tracking is disabled")) {
            container.innerHTML = `
                <div style="display: flex; justify-content: center; align-items: center; height: 400px; background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px;">
                    <div style="text-align: center; color: #6c757d;">
                        <h4>GPS Tracking Disabled</h4>
                        <p>${apiKey.error}</p>
                        <p>Please contact your administrator to enable GPS tracking.</p>
                    </div>
                </div>
            `;
            return;
        }

        if (gpsDataResp.error && gpsDataResp.error.includes("GPS tracking is disabled")) {
            container.innerHTML = `
                <div style="display: flex; justify-content: center; align-items: center; height: 400px; background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px;">
                    <div style="text-align: center; color: #6c757d;">
                        <h4>GPS Tracking Disabled</h4>
                        <p>${gpsDataResp.error}</p>
                        <p>Please contact your administrator to enable GPS tracking.</p>
                    </div>
                </div>
            `;
            return;
        }

        const gpsData = gpsDataResp.points || gpsDataResp;

        // Apply smart clustering and filtering
        const filteredData = this.smartClusterAndFilter(gpsData);
        console.log(`Original points: ${gpsData.length}, Filtered points: ${filteredData.length}`);

        // PRESERVE existing info and ADD/UPDATE route-specific data
        this.state.info = {
            ...this.state.info, // Keep existing data (work_hours, rest_hours, etc.)
            speed_kmh: gpsDataResp.speed_kmh,
            traveled_duration: gpsDataResp.traveled_duration,
            speed_is_unusual: gpsDataResp.speed_kmh > 100,
            total_points: gpsData.length,
            filtered_points: filteredData.length
        };

        // Handle duration calculation
        console.log("🔍 Duration data from API:", {
            expected_duration: gpsDataResp.expected_duration,
            expected_duration_formatted: gpsDataResp.expected_duration_formatted,
            duration_s: gpsDataResp.duration_s,
            traveled_duration: gpsDataResp.traveled_duration
        });

        if (gpsDataResp.expected_duration_formatted) {
            // Use the pre-formatted duration from backend
            this.state.info.expected_duration = gpsDataResp.expected_duration_formatted;
            console.log("✅ Set expected_duration from formatted field:", this.state.info.expected_duration);
        } else if (gpsDataResp.expected_duration) {
            // Format the duration from seconds
            const totalSeconds = Math.floor(gpsDataResp.expected_duration);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            this.state.info.expected_duration = [
                hours.toString().padStart(2, '0'),
                minutes.toString().padStart(2, '0'),
                seconds.toString().padStart(2, '0')
            ].join(':');
            console.log("✅ Set expected_duration from seconds:", this.state.info.expected_duration);
        } else if (gpsDataResp.duration_s) {
            // Fallback to old duration_s field if it exists
            const totalSeconds = Math.floor(gpsDataResp.duration_s);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            this.state.info.expected_duration = [
                hours.toString().padStart(2, '0'),
                minutes.toString().padStart(2, '0'),
                seconds.toString().padStart(2, '0')
            ].join(':');
            console.log("✅ Set expected_duration from duration_s:", this.state.info.expected_duration);
        } else {
            console.log("⚠️ No duration data available");
        }

        // Handle actual traveled distance from API response
        if (gpsDataResp.total_traveled_distance_km) {
            // Use the accurate traveled distance from API (Google Maps routes)
            this.state.info.actual_distance = `${gpsDataResp.total_traveled_distance_km} km`;
        } else {
            // Calculate local traveled distance as fallback
            const localTraveledDistance = this.calculateActualTraveledDistanceFromRawData(gpsData);
            this.state.info.actual_distance = localTraveledDistance > 0 ? this.formatDistance(localTraveledDistance) : '0 km';
        }

        console.log("Final state.info after renderMap:", this.state.info);
        console.log("🔍 Duration fields in final state:", {
            expected_duration: this.state.info.expected_duration,
            traveled_duration: this.state.info.traveled_duration,
            duration: this.state.info.duration
        });

        if (!filteredData || filteredData.length < 1) {
            this.state.info.duration = null;
            container.innerHTML = `
                <div style="display: flex; justify-content: center; align-items: center; height: 400px; background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px;">
                    <div style="text-align: center; color: #6c757d;">
                        <h4>No GPS Data Found</h4>
                        <p>No GPS tracking data found for the selected date.</p>
                        <p>Make sure GPS tracking was active during attendance.</p>
                    </div>
                </div>
            `;
            return;
        }

        if (!window.google || !window.google.maps) {
            const script = document.createElement("script");
            script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey.api_key}&libraries=marker&v=weekly`;
            script.async = true;
            script.defer = true;
            script.onload = () => this.initMap(container, filteredData);
            document.head.appendChild(script);
        } else {
            this.initMap(container, filteredData);
        }
    }

    async initMap(container, data, isLiveMode = false) {
        if (!Array.isArray(data) || data.length < 1) return;

        const origin = { lat: data[0].lat, lng: data[0].lng };
        const destination = data.length > 1 ? {
            lat: data[data.length - 1].lat,
            lng: data[data.length - 1].lng
        } : origin;

        const map = new google.maps.Map(container, {
            zoom: 14,
            center: origin,
            mapId: "DEMO_MAP_ID",
            gestureHandling: "cooperative",
        });

        // Add live tracking indicator if in live mode
        if (isLiveMode) {
            const liveControl = document.createElement('div');
            liveControl.style.cssText = `
                position: absolute;
                top: 10px;
                right: 10px;
                background: #ff4444;
                color: white;
                padding: 8px 12px;
                border-radius: 20px;
                font-size: 12px;
                font-weight: bold;
                z-index: 1000;
                animation: pulse 2s infinite;
            `;
            liveControl.innerHTML = 'LIVE TRACKING';
            container.appendChild(liveControl);
        }

        // Create markers with enhanced categorization and comment support
        data.forEach((p, i) => {
            const marker = new google.maps.marker.AdvancedMarkerElement({
                map,
                position: { lat: p.lat, lng: p.lng },
                content: (() => {
                    const el = document.createElement("div");

                    // Enhanced color coding logic based on tracking_type
                    if (p.tracking_type === 'check_in') {
                        el.style.backgroundColor = "green";
                        el.title = "Check In Point";
                        if (p.comment) {
                            el.style.border = "3px solid #ffd700";
                            el.style.boxShadow = "0 0 8px #ffd700";
                        }
                    } else if (p.tracking_type === 'check_out') {
                        el.style.backgroundColor = "red";
                        el.title = "Check Out Point";
                        if (p.comment) {
                            el.style.border = "3px solid #ffd700";
                            el.style.boxShadow = "0 0 8px #ffd700";
                        }
                    } else if (p.tracking_type === 'customer_check_in') {
                        el.style.backgroundColor = "blue";
                        el.title = "Customer Check In Point";
                        if (p.comment) {
                            el.style.border = "3px solid #ffd700";
                            el.style.boxShadow = "0 0 8px #ffd700";
                        }
                    } else if (p.tracking_type === 'customer_check_out') {
                        el.style.backgroundColor = "purple";
                        el.title = "Customer Check Out Point";
                        if (p.comment) {
                            el.style.border = "3px solid #ffd700";
                            el.style.boxShadow = "0 0 8px #ffd700";
                        }
                    } else {
                        el.style.backgroundColor = "yellow";
                        el.title = "Route Point";
                    }

                    el.style.width = el.style.height = p.comment ? "16px" : "12px";
                    el.style.borderRadius = "50%";
                    if (!p.comment) {
                        el.style.boxShadow = "0 0 3px #000";
                    }

                    return el;
                })(),
            });

            // Enhanced info window with comment support
            const infoContent = `
                <div style="max-width: 300px;">
                    <div style="font-weight: bold; margin-bottom: 8px; color: #333;">
                        ${this.getTrackingTypeDisplay(p.tracking_type)} - Position ${i + 1}/${data.length}
                    </div>
                    <div style="margin-bottom: 4px;">
                        <strong>Coordinates:</strong> ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}
                    </div>
                    <div style="margin-bottom: 4px;">
                        <strong>Time:</strong> ${p.timestamp ? new Date(p.timestamp).toLocaleString() : 'N/A'}
                    </div>
                    <div style="margin-bottom: 4px;">
                        <strong>Type:</strong> ${this.getTrackingTypeDisplay(p.tracking_type)}
                    </div>
                    ${p.customer_id ? `<div style="margin-bottom: 4px;"><strong>Customer:</strong> ${p.customer_name || 'N/A'}</div>` : ''}
                    ${p.contact_id ? `<div style="margin-bottom: 4px;"><strong>Contact:</strong> ${p.contact_name || 'N/A'}</div>` : ''}
                    ${p.comment ? `
                        <div style="margin-top: 8px; padding: 8px; background-color: #f0f8ff; border-left: 4px solid #4CAF50; border-radius: 4px;">
                            <strong>Comment:</strong>
                            <div style="margin-top: 4px; font-style: italic; color: #555;">"${p.comment}"</div>
                        </div>
                    ` : ''}
                </div>
            `;

            const infoWindow = new google.maps.InfoWindow({
                content: infoContent
            });

            marker.addListener("click", () => {
                infoWindow.open({
                    anchor: marker,
                    map,
                    shouldFocus: false,
                });
            });
        });

        // NEW: Create separate route paths for each direction using Google Maps Directions API
        if (data.length >= 2) {
            await this.createRoutePaths(map, data, isLiveMode);
        } else if (isLiveMode && data.length === 1) {
            // For single point in live mode, just show the point
            const polyline = new google.maps.Polyline({
                path: data.map(p => ({ lat: p.lat, lng: p.lng })),
                geodesic: true,
                strokeColor: '#ff4444',
                strokeOpacity: 0.8,
                strokeWeight: 6,
            });
            polyline.setMap(map);
        }
    }

    // NEW: Method to create separate route paths for each direction
    async createRoutePaths(map, data, isLiveMode = false) {
        try {
            // Group GPS points by direction changes (when employee changes direction significantly)
            const routeSegments = this.identifyRouteSegments(data);

            console.log(`Identified ${routeSegments.length} route segments:`, routeSegments);

            // Create a route for each segment using Google Maps Directions API
            for (let i = 0; i < routeSegments.length; i++) {
                const segment = routeSegments[i];
                const segmentColor = this.getSegmentColor(i, routeSegments.length);

                await this.createSegmentRoute(map, segment, segmentColor, isLiveMode, i + 1);
            }

            // Update the route legend with actual segments
            this.updateRouteLegend(routeSegments);

        } catch (error) {
            console.error("Error creating route paths:", error);
            // Fallback to simple polyline if Directions API fails
            this.createFallbackPolyline(map, data, isLiveMode);
        }
    }

    // NEW: Method to update the route legend dynamically
    updateRouteLegend(routeSegments) {
        const legendContainer = document.querySelector('.o_legend_items');
        if (!legendContainer) return;

        // Clear existing legend
        legendContainer.innerHTML = '';

        // Create legend items for each segment
        routeSegments.forEach((segment, index) => {
            const color = this.getSegmentColor(index, routeSegments.length);
            const segmentType = this.getSegmentType(index, routeSegments.length);

            const legendItem = document.createElement('div');
            legendItem.className = 'o_legend_item';
            legendItem.innerHTML = `
                <span class="o_legend_color" style="background-color: ${color};"></span>
                <span class="o_legend_text">Segment ${index + 1} (${segmentType})</span>
            `;

            legendContainer.appendChild(legendItem);
        });

        // Update legend description
        const legendDescription = document.querySelector('.o_route_legend small');
        if (legendDescription) {
            legendDescription.innerHTML = `
                <i class="fa fa-info-circle"></i>
                ${routeSegments.length} route segment${routeSegments.length > 1 ? 's' : ''} detected.
                Routes use Google Maps for accurate path calculation.
            `;
        }
    }

    // NEW: Method to identify route segments based on direction changes
    identifyRouteSegments(data) {
        if (data.length < 3) {
            return [data]; // Single segment for small datasets
        }

        const segments = [];
        let currentSegment = [data[0]];
        let lastDirection = null;

        for (let i = 1; i < data.length; i++) {
            const prevPoint = data[i - 1];
            const currPoint = data[i];

            // Calculate direction vector
            const dx = currPoint.lng - prevPoint.lng;
            const dy = currPoint.lat - prevPoint.lat;
            const currentDirection = Math.atan2(dy, dx);

            // Check if direction changed significantly (more than 45 degrees)
            if (lastDirection !== null) {
                const directionChange = Math.abs(currentDirection - lastDirection);
                const normalizedChange = Math.min(directionChange, 2 * Math.PI - directionChange);

                if (normalizedChange > Math.PI / 4) { // 45 degrees
                    // Direction changed significantly, start new segment
                    if (currentSegment.length > 0) {
                        segments.push([...currentSegment]);
                    }
                    currentSegment = [prevPoint, currPoint];
                } else {
                    // Continue current segment
                    currentSegment.push(currPoint);
                }
            } else {
                // First point, just add to current segment
                currentSegment.push(currPoint);
            }

            lastDirection = currentDirection;
        }

        // Add the last segment
        if (currentSegment.length > 0) {
            segments.push(currentSegment);
        }

        // Ensure we have at least one segment
        if (segments.length === 0) {
            segments.push(data);
        }

        return segments;
    }

    // NEW: Method to get different colors for different route segments
    getSegmentColor(segmentIndex, totalSegments) {
        const colors = [
            '#4285F4', // Google Blue
            '#EA4335', // Google Red
            '#FBBC05', // Google Yellow
            '#34A853', // Google Green
            '#FF6D01', // Orange
            '#46BDC6', // Teal
            '#7B1FA2', // Purple
            '#FF5722', // Deep Orange
        ];

        return colors[segmentIndex % colors.length];
    }

    // NEW: Method to determine segment type based on position and total segments
    getSegmentType(segmentIndex, totalSegments) {
        if (totalSegments === 1) {
            return 'Single Route';
        } else if (totalSegments === 2) {
            return segmentIndex === 0 ? 'Outbound' : 'Return';
        } else if (totalSegments === 3) {
            if (segmentIndex === 0) return 'Outbound';
            else if (segmentIndex === 1) return 'Return';
            else return 'Additional';
        } else {
            if (segmentIndex === 0) return 'Outbound';
            else if (segmentIndex === totalSegments - 1) return 'Return';
            else return `Route ${segmentIndex + 1}`;
        }
    }

    // NEW: Method to create a route for a specific segment
    async createSegmentRoute(map, segmentData, color, isLiveMode, segmentNumber) {
        if (segmentData.length < 2) return;

        return new Promise((resolve) => {
            const directions = new google.maps.DirectionsService();
            const renderer = new google.maps.DirectionsRenderer({
                suppressMarkers: true, // We already have our custom markers
                polylineOptions: {
                    strokeColor: color,
                    strokeWeight: isLiveMode ? 6 : 5,
                    strokeOpacity: isLiveMode ? 0.8 : 1.0,
                    zIndex: segmentNumber, // Higher segments appear on top
                },
            });

            renderer.setMap(map);

            // Create waypoints for the segment
            const waypoints = segmentData.slice(1, -1).map(p => ({
                location: { lat: p.lat, lng: p.lng },
                stopover: false
            }));

            const request = {
                origin: { lat: segmentData[0].lat, lng: segmentData[0].lng },
                destination: { lat: segmentData[segmentData.length - 1].lat, lng: segmentData[segmentData.length - 1].lng },
                waypoints: waypoints,
                travelMode: google.maps.TravelMode.DRIVING, // Use DRIVING for more realistic routes
                optimizeWaypoints: false, // Keep waypoints in order
            };

            directions.route(request, (result, status) => {
                if (status === "OK") {
                    renderer.setDirections(result);

                    // Add segment label
                    this.addSegmentLabel(map, segmentData[0], segmentNumber, color);

                    console.log(`✅ Created route for segment ${segmentNumber} with ${segmentData.length} points`);
                    resolve(result);
                } else {
                    console.warn(`⚠️ Failed to create route for segment ${segmentNumber}:`, status);
                    // Fallback to simple polyline for this segment
                    this.createSegmentPolyline(map, segmentData, color, isLiveMode);
                    resolve(null);
                }
            });
        });
    }

    // NEW: Method to add segment labels on the map
    addSegmentLabel(map, position, segmentNumber, color) {
        const label = new google.maps.Marker({
            position: position,
            map: map,
            label: {
                text: `S${segmentNumber}`,
                color: 'white',
                fontSize: '12px',
                fontWeight: 'bold'
            },
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                fillColor: color,
                fillOpacity: 0.8,
                strokeColor: 'white',
                strokeWeight: 2,
                scale: 12
            },
            zIndex: 1000
        });
    }

    // NEW: Method to create fallback polyline for a segment
    createSegmentPolyline(map, segmentData, color, isLiveMode) {
        const polyline = new google.maps.Polyline({
            path: segmentData.map(p => ({ lat: p.lat, lng: p.lng })),
            geodesic: true,
            strokeColor: color,
            strokeOpacity: isLiveMode ? 0.8 : 1.0,
            strokeWeight: isLiveMode ? 6 : 5,
            zIndex: 1
        });
        polyline.setMap(map);
    }

    // NEW: Fallback method if Directions API fails completely
    createFallbackPolyline(map, data, isLiveMode) {
        console.log("Using fallback polyline method");
        const polyline = new google.maps.Polyline({
            path: data.map(p => ({ lat: p.lat, lng: p.lng })),
            geodesic: true,
            strokeColor: isLiveMode ? '#ff4444' : '#53ff1a',
            strokeOpacity: isLiveMode ? 0.8 : 1.0,
            strokeWeight: isLiveMode ? 6 : 5,
        });
        polyline.setMap(map);
    }

    // Helper method to format duration
    formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;

        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else if (minutes > 0) {
            return `${minutes}m ${secs}s`;
        } else {
            return `${secs}s`;
        }
    }

    // Helper method to get display text for tracking types
    getTrackingTypeDisplay(trackingType) {
        const typeMap = {
            'check_in': 'Check In',
            'check_out': 'Check Out',
            'customer_check_in': 'Customer Check In',
            'customer_check_out': 'Customer Check Out',
            'route_point': 'Route Point',
        };
        return typeMap[trackingType] || 'Unknown';
    }

    async onChangeFilter(ev) {
        const name = ev.target.name;
        const value = ev.target.value;
        this.state[name] = value;
        await this.loadEmployeeData();
        await this.renderMap();
    }

    static template = "field_service_tracking.tracking_route_template";
}

registry.category("actions").add("gps_tracking_route_map", GpsTrackingMap);