/** @odoo-module **/

import { FormController } from "@web/views/form/form_controller";
import { patch } from "@web/core/utils/patch";

patch(FormController.prototype, {
    async beforeExecuteActionButton(clickParams) {
        const { name } = clickParams;
        const GEO_ACTIONS = [
            // Customer check-in/check-out actions
            "action_customer_check_in",
            "action_customer_check_out"
        ];

        console.log("▶️ Button clicked:", name);

        // Get notification service
        const notification = this.notification || (this.env.services && this.env.services.notification);

        if (GEO_ACTIONS.includes(name)) {
            if (!navigator.geolocation) {
                console.error("❌ Geolocation not supported");
                return super.beforeExecuteActionButton(clickParams);
            }

            try {
                const position = await this._getLocation();
                const latitude = position.coords.latitude;
                const longitude = position.coords.longitude;
                console.log("✅ Location obtained for customer action:", latitude, longitude);

                // Update the context with GPS coordinates
                clickParams.context = {
                    ...clickParams.context,
                    default_latitude: latitude,
                    default_longitude: longitude
                };
            } catch (error) {
                console.error("⚠️ Failed to get geolocation:", error);
                if (notification) {
                    notification.add("Failed to get your location. Please allow location access in your browser.", { type: "warning" });
                }
            }
        }

        return super.beforeExecuteActionButton(clickParams);
    },

    _getLocation() {
        return new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 30000
            });
        });
    }
});