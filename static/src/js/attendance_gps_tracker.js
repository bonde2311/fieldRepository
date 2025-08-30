/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { ActivityMenu } from "@hr_attendance/components/attendance_menu/attendance_menu";
import { _t } from "@web/core/l10n/translation";

console.log("GPS patch for ActivityMenu loaded");

// Apply GPS tracking patch with face recognition compatibility
patch(ActivityMenu.prototype, {
    willStart() {
        // Call original willStart if it exists
        if (this._super && typeof this._super === 'function') {
            return this._super(...arguments);
        }
        return Promise.resolve();
    },

    mounted() {
        // Call original mounted if it exists
        if (this._super && typeof this._super === 'function') {
            this._super(...arguments);
        }

        // Add GPS tracking status check after component is mounted
        setTimeout(() => {
            this.checkGPSTrackingStatus();
        }, 100);

        // Check GPS status every 30 seconds
        this.gpsStatusInterval = setInterval(() => {
            this.checkGPSTrackingStatus();
        }, 30000);
    },

    willUnmount() {
        // Call original willUnmount if it exists
        if (this._super && typeof this._super === 'function') {
            this._super(...arguments);
        }

        // Clean up interval
        if (this.gpsStatusInterval) {
            clearInterval(this.gpsStatusInterval);
        }
    },

    // NEW: Method to check and display GPS tracking status
    checkGPSTrackingStatus() {
        try {
            const gpsTracker = window.odoo?.gpsTracker;
            if (!gpsTracker) {
                console.log("GPS tracker not available yet");
                return;
            }

            const isTracking = gpsTracker.isTrackingActive();
            const session = gpsTracker.getCurrentSession();

            // Update the attendance button to show GPS status
            const attendanceButton = document.querySelector('.o_hr_attendance_sign_in_out');
            if (attendanceButton) {
                // Remove existing GPS indicator
                const existingIndicator = attendanceButton.querySelector('.gps-status-indicator');
                if (existingIndicator) {
                    existingIndicator.remove();
                }

                // Add GPS status indicator if tracking is active
                if (isTracking && session) {
                    const indicator = document.createElement('div');
                    indicator.className = 'gps-status-indicator';
                    indicator.style.cssText = `
                        position: absolute;
                        top: -5px;
                        right: -5px;
                        width: 12px;
                        height: 12px;
                        background-color: #28a745;
                        border-radius: 50%;
                        border: 2px solid white;
                        animation: pulse 2s infinite;
                        z-index: 1000;
                    `;
                    indicator.title = 'GPS Tracking Active';
                    attendanceButton.style.position = 'relative';
                    attendanceButton.appendChild(indicator);
                }
            }
        } catch (error) {
            console.error("Error in checkGPSTrackingStatus:", error);
        }
    },

    async signInOut() {
        const gpsTracker = window.odoo?.gpsTracker;
        const wasCheckedIn = this.state.checkedIn;

        let isGpsEnabled = false;
        if (gpsTracker) {
            isGpsEnabled = await gpsTracker.isGpsTrackingEnabled();
        }

        navigator.geolocation.getCurrentPosition(
            async ({ coords: { latitude, longitude } }) => {
                try {
                    const result = await this.rpc("/hr_attendance/systray_check_in_out_with_comment", {
                        latitude,
                        longitude,
                    });

                    await this.searchReadEmployee();

                    if (gpsTracker && isGpsEnabled) {
                        if (!wasCheckedIn) {
                            console.log("🟢 Starting GPS tracking");
                            await gpsTracker.startGPSTracking(undefined, result.attendance_id, undefined, "route_point");
                        } else {
                            console.log("🔴 Stopping GPS tracking");
                            await gpsTracker.stopGPSTracking();
                        }
                    }

                    this.env.services.notification.add(
                        wasCheckedIn ? _t("Successfully checked out!") : _t("Successfully checked in!"),
                        { type: "success" }
                    );
                } catch (error) {
                    console.error("❌ Error in GPS flow:", error);
                    this.env.services.notification.add(_t("Error during check-in/out. Please try again."), {
                        type: "danger",
                    });
                }
            },
            async (error) => {
                console.warn("⚠️ Geolocation error:", error.message);
                try {
                    const result = await this.rpc("/hr_attendance/systray_check_in_out_with_comment", {
                        latitude: null,
                        longitude: null,
                    });

                    await this.searchReadEmployee();

                    if (gpsTracker && wasCheckedIn && isGpsEnabled) {
                        console.log("Stopping GPS tracking after geolocation error");
                        await gpsTracker.stopGPSTracking();
                    } else if (gpsTracker && !wasCheckedIn && isGpsEnabled) {
                        console.log("Starting GPS tracking after geolocation error");
                        await gpsTracker.startGPSTracking(undefined, result.attendance_id, undefined, "route_point");
                    }

                    this.env.services.notification.add(
                        _t("GPS access denied but attendance recorded successfully!"),
                        { type: "warning" }
                    );
                } catch (fallbackError) {
                    console.error("❌ Fallback error:", fallbackError);
                    this.env.services.notification.add(
                        _t("Error recording attendance. Please try again."),
                        { type: "danger" }
                    );
                }
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
        );
    },
});