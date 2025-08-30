from odoo import models, fields, api
from datetime import datetime, timedelta
import logging

_logger = logging.getLogger(__name__)


class GpsTracking(models.Model):
    _name = 'gps.tracking'
    _description = 'Employee GPS Tracking Data'
    _order = 'timestamp asc'

    timestamp = fields.Datetime(default=fields.Datetime.now)
    latitude = fields.Float(string='Latitude', digits=(16, 6))
    longitude = fields.Float(string='Longitude', digits=(16, 6))
    employee_id = fields.Many2one('hr.employee', string='Employee')
    attendance_id = fields.Many2one('hr.attendance', string='Attendance')
    task_id = fields.Many2one('project.task', string='Task')
    # NEW: Customer/Contact fields
    customer_id = fields.Many2one('res.partner', string='Customer/Contact', domain=[('is_company', '=', True)])
    contact_id = fields.Many2one('res.partner', string='Contact Person', domain=[('is_company', '=', False)])
    synced = fields.Boolean(default=False)
    tracking_type = fields.Selection([
        ('check_in', 'Check In'),
        ('check_out', 'Check Out'),
        ('customer_check_in', 'Customer Check In'),
        ('customer_check_out', 'Customer Check Out'),
        ('route_point', 'Route Point'),
    ], default='route_point', string='Tracking Type', required=True)

    # NEW: Comment field for check-in/check-out
    comment = fields.Text(string='Comment')
    work_hours = fields.Float("Work Hours", compute="_compute_hours", store=False)
    rest_hours = fields.Float("Rest Hours", compute="_compute_hours", store=False)
    actual_traveled_distance = fields.Float("Actual Traveled Distance (km)", compute="_compute_actual_distance",
                                            store=False)

    @api.depends('attendance_id', 'timestamp')
    def _compute_actual_distance(self):
        """Compute actual traveled distance for this tracking point's attendance session using Google Maps"""
        for record in self:
            if record.attendance_id and record.attendance_id.check_in and record.attendance_id.check_out:
                # Get all GPS points for this attendance session
                attendance_points = self.search([
                    ('attendance_id', '=', record.attendance_id.id)
                ], order='timestamp')

                if len(attendance_points) > 1:
                    # Use Google Maps API for accurate route distance calculation
                    total_distance = self.calculate_google_maps_route_distance(attendance_points)
                    record.actual_traveled_distance = round(total_distance / 1000, 2)  # Convert to km
                else:
                    record.actual_traveled_distance = 0.0
            else:
                record.actual_traveled_distance = 0.0

    def calculate_google_maps_route_distance(self, attendance_points):
        """Calculate actual route distance using Google Maps Directions API"""
        try:
            if len(attendance_points) < 2:
                return 0.0

            # Get Google Maps API key
            api_key = self.env['ir.config_parameter'].sudo().get_param('base_geolocalize.google_map_api_key')
            if not api_key:
                # Don't fall back to straight-line if no API key - force user to configure
                _logger.error("❌ Google Maps API key not configured - cannot calculate accurate route distances")
                return 0.0

            # Group points into route segments based on direction changes
            route_segments = self.identify_route_segments(attendance_points)

            total_distance = 0.0
            for segment in route_segments:
                if len(segment) >= 2:
                    segment_distance = self.calculate_segment_distance_google_maps(segment, api_key)
                    total_distance += segment_distance

            return total_distance

        except Exception as e:
            _logger.error(f"❌ Error in Google Maps route distance calculation: {str(e)}")
            # Don't fall back to straight-line on errors - force user to fix issues
            return 0.0

    def identify_route_segments(self, attendance_points):
        """Identify route segments based on direction changes"""
        if len(attendance_points) < 3:
            return [attendance_points]

        import math
        segments = []
        current_segment = [attendance_points[0]]
        last_direction = None

        for i in range(1, len(attendance_points)):
            prev_point = attendance_points[i - 1]
            curr_point = attendance_points[i]

            # Calculate direction vector
            dx = curr_point.longitude - prev_point.longitude
            dy = curr_point.latitude - prev_point.latitude
            current_direction = math.atan2(dy, dx)

            # Check if direction changed significantly (more than 45 degrees)
            if last_direction is not None:
                direction_change = abs(current_direction - last_direction)
                normalized_change = min(direction_change, 2 * math.pi - direction_change)

                if normalized_change > math.pi / 4:  # 45 degrees
                    # Direction changed significantly, start new segment
                    if current_segment:
                        segments.append(current_segment)
                    current_segment = [prev_point, curr_point]
                else:
                    # Continue current segment
                    current_segment.append(curr_point)
            else:
                # First point, just add to current segment
                current_segment.append(curr_point)

            last_direction = current_direction

        # Add the last segment
        if current_segment:
            segments.append(current_segment)

        return segments if segments else [attendance_points]

    def calculate_segment_distance_google_maps(self, segment_points, api_key):
        """Calculate distance for a specific segment using Google Maps API"""
        try:
            if len(segment_points) < 2:
                return 0.0

            # Create waypoints for the segment
            waypoints = []
            for i in range(1, len(segment_points) - 1):
                waypoints.append(f"{segment_points[i].latitude},{segment_points[i].longitude}")

            # Build Google Maps Directions API URL
            origin = f"{segment_points[0].latitude},{segment_points[0].longitude}"
            destination = f"{segment_points[-1].latitude},{segment_points[-1].longitude}"

            waypoints_str = "|".join(waypoints) if waypoints else ""

            url = "https://maps.googleapis.com/maps/api/directions/json"
            params = {
                'origin': origin,
                'destination': destination,
                'waypoints': waypoints_str,
                'mode': 'driving',  # Use driving mode for realistic routes
                'key': api_key
            }

            # Make request to Google Maps API
            import requests
            response = requests.get(url, params=params, timeout=15)  # Increased timeout

            if response.status_code == 200:
                data = response.json()

                if data.get('status') == 'OK' and data.get('routes'):
                    route = data['routes'][0]
                    total_distance = 0

                    # Sum up distances from all legs
                    for leg in route.get('legs', []):
                        total_distance += leg.get('distance', {}).get('value', 0)  # Distance in meters

                    _logger.info(f"✅ Google Maps segment distance: {total_distance}m for {len(segment_points)} points")
                    return total_distance
                else:
                    _logger.error(
                        f"❌ Google Maps API returned status: {data.get('status')} - {data.get('error_message', 'Unknown error')}")
                    # Only fall back to straight-line if it's a ZERO_RESULTS error (no route found)
                    if data.get('status') == 'ZERO_RESULTS':
                        _logger.warning("⚠️ No route found between segment points, using straight-line fallback")
                        return self.calculate_straight_line_distance_fallback(segment_points)
                    else:
                        # For other API errors, don't fall back - force user to fix API issues
                        return 0.0
            else:
                _logger.error(f"❌ Google Maps API request failed with status: {response.status_code}")
                # Don't fall back for HTTP errors - force user to check API configuration
                return 0.0

        except requests.exceptions.Timeout:
            _logger.error("❌ Google Maps API request timed out")
            return 0.0
        except requests.exceptions.RequestException as e:
            _logger.error(f"❌ Google Maps API request exception: {str(e)}")
            return 0.0
        except Exception as e:
            _logger.error(f"❌ Unexpected error in Google Maps API call: {str(e)}")
            return 0.0

    def calculate_straight_line_distance_fallback(self, attendance_points):
        """Fallback method to calculate straight-line distance"""
        try:
            from math import radians, cos, sin, asin, sqrt

            total_distance = 0.0
            for i in range(1, len(attendance_points)):
                prev_point = attendance_points[i - 1]
                curr_point = attendance_points[i]

                # Calculate distance between consecutive points using Haversine formula
                lat1, lon1 = radians(prev_point.latitude), radians(prev_point.longitude)
                lat2, lon2 = radians(curr_point.latitude), radians(curr_point.longitude)

                dlat = lat2 - lat1
                dlon = lon2 - lon1

                a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
                c = 2 * asin(sqrt(a))
                r = 6371  # Radius of earth in kilometers

                distance = c * r * 1000  # Convert to meters
                total_distance += distance

            return total_distance

        except Exception as e:
            return 0.0

    @api.model
    def get_daily_hours(self, employee_id, date_str):
        """Return work and rest hours for a given employee and date."""
        date = fields.Date.from_string(date_str)
        start = datetime.combine(date, datetime.min.time())
        end = datetime.combine(date, datetime.max.time())
        print("Date", date)
        print("Start", start)
        print("End", end)
        attendance = self.env["hr.attendance"].search([
            ("employee_id", "=", employee_id),
            ("check_in", ">=", start),
            ("check_in", "<=", end),
        ])
        print("The Attendance One", attendance)
        if not attendance or not attendance.check_in or not attendance.check_out:
            return {"work_hours": 0.0, "rest_hours": 0.0}

        # get customer check-in/out points of the day
        points = self.search([
            ("attendance_id", "=", attendance.id),
            ("tracking_type", "in", ["customer_check_in", "customer_check_out"]),
        ], order="timestamp asc")

        print("Points Data", points)

        work_time = timedelta()
        stack = None
        for p in points:
            if p.tracking_type == "customer_check_in":
                stack = p.timestamp
            elif p.tracking_type == "customer_check_out" and stack:
                work_time += p.timestamp - stack
                stack = None

        total_time = attendance.check_out - attendance.check_in
        rest_time = total_time - work_time
        print("The Total Time", total_time)
        print("The Rest Time", rest_time)
        return {
            "work_hours": round(work_time.total_seconds() / 3600, 2),
            "rest_hours": round(rest_time.total_seconds() / 3600, 2),
        }

    def _compute_hours(self):
        for rec in self:
            work_time = timedelta()
            rest_time = timedelta()

            att = rec.attendance_id
            if att and att.check_in and att.check_out:
                # get all customer check-in/out records linked to this attendance
                tracking = self.env["gps.tracking"].search([
                    ("attendance_id", "=", att.id),
                    ("tracking_type", "in", ["customer_check_in", "customer_check_out"]),
                ], order="timestamp asc")

                stack = None
                for t in tracking:
                    if t.tracking_type == "customer_check_in":
                        stack = t.timestamp
                    elif t.tracking_type == "customer_check_out" and stack:
                        work_time += t.timestamp - stack
                        stack = None

                total_time = att.check_out - att.check_in
                rest_time = total_time - work_time

                rec.work_hours = work_time.total_seconds() / 3600
                rec.rest_hours = rest_time.total_seconds() / 3600
            else:
                rec.work_hours = 0
                rec.rest_hours = 0

    @api.model
    def create_route_point(self, employee_id, latitude, longitude, tracking_type='route_point', task_id=None,
                           comment=None, customer_id=None, contact_id=None):
        """Create a new route tracking point"""
        employee = self.env['hr.employee'].browse(employee_id)
        # Check if employee has a user and GPS tracking is enabled
        if not employee.user_id or not employee.user_id.enable_gps_tracking:
            print(f"GPS tracking is disabled for employee {employee.name}")
            return False

        # Get current active attendance session
        attendance = self.env['hr.attendance'].search([
            ('employee_id', '=', employee_id),
            ('check_out', '=', False)
        ], limit=1)

        vals = {
            'employee_id': employee_id,
            'attendance_id': attendance.id if attendance else False,
            'latitude': latitude,
            'longitude': longitude,
            'tracking_type': tracking_type,
            'task_id': task_id,
            'customer_id': customer_id,
            'contact_id': contact_id,
            'timestamp': fields.Datetime.now(),
            'comment': comment,  # NEW: Include comment
        }
        return self.create(vals)


# Extend existing models to integrate tracking
class HrAttendance(models.Model):
    _inherit = 'hr.attendance'

    @api.model
    def create(self, vals):
        """Override create to add route tracking"""
        attendance = super().create(vals)

        # Create route tracking point for check-in
        if 'check_in' in vals and vals.get('in_latitude') and vals.get(
                'in_longitude') and attendance.employee_id.user_id and attendance.employee_id.user_id.enable_gps_tracking:
            self.env['gps.tracking'].create_route_point(
                employee_id=attendance.employee_id.id,
                latitude=vals['in_latitude'],
                longitude=vals['in_longitude'],
                tracking_type='check_in'
            )

        return attendance

    def write(self, vals):
        """Override write to handle check-out tracking"""
        result = super().write(vals)

        # Create route tracking point for check-out
        if 'check_out' in vals and vals.get('out_latitude') and vals.get('out_longitude'):
            for attendance in self:
                if (attendance.employee_id.user_id and
                        attendance.employee_id.user_id.enable_gps_tracking):
                    self.env['gps.tracking'].create_route_point(
                        employee_id=attendance.employee_id.id,
                        latitude=vals['out_latitude'],
                        longitude=vals['out_longitude'],
                        tracking_type='check_out'
                    )

        return result


class ResPartner(models.Model):
    _inherit = 'res.partner'

    # Customer check-in history
    customer_checkins = fields.One2many('gps.tracking', 'customer_id', string='Customer Check-ins')
    contact_checkins = fields.One2many('gps.tracking', 'contact_id', string='Contact Check-ins')

    def action_customer_check_in(self):
        latitude = self.env.context.get("default_latitude", 0.0)
        longitude = self.env.context.get("default_longitude", 0.0)
        """Action to check in against this customer"""
        return {
            'name': 'Customer Check-in',
            'type': 'ir.actions.act_window',
            'res_model': 'customer.checkin.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'default_customer_id': self.id,
                'default_contact_id': self.id if not self.is_company else False,
                'default_latitude': latitude,  # Will be updated by JavaScript
                'default_longitude': longitude,  # Will be updated by JavaScript
            }
        }

    def action_customer_check_out(self):
        """Action to check out from this customer"""
        latitude = self.env.context.get("default_latitude", 0.0)
        longitude = self.env.context.get("default_longitude", 0.0)
        return {
            'name': 'Customer Check-out',
            'type': 'ir.actions.act_window',
            'res_model': 'customer.checkout.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'default_customer_id': self.id,
                'default_contact_id': self.id if not self.is_company else False,
                'default_latitude': latitude,  # Will be updated by JavaScript
                'default_longitude': longitude,  # Will be updated by JavaScript
            }
        }


class ResUsers(models.Model):
    _inherit = 'res.users'

    enable_gps_tracking = fields.Boolean(
        string='Enable GPS Tracking',
        default=False,
        help='Enable GPS tracking for this user. When disabled, the user will not be able to send GPS data or view tracking information.'
    )