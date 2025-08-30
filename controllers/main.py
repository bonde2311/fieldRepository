from odoo import http, fields
from odoo.http import request
from datetime import datetime, timedelta
from dateutil import parser
import logging
import math

_logger = logging.getLogger(__name__)


class GpsTrackingController(http.Controller):

    @http.route('/live/gps/work_rest_hours', type='json', auth='user')
    def work_rest_hours(self, employee_id, date_str):
        return request.env['gps.tracking'].sudo().get_daily_hours(employee_id, date_str)

    @http.route('/live/gps/update', type='json', auth='user')
    def gps_update(self, **kwargs):
        data = kwargs
        _logger.info(f"📡 Received GPS data: {data}")

        try:
            # Check if the current user has GPS tracking enabled
            current_user = request.env.user
            if not current_user.enable_gps_tracking:
                return {'status': 'error', 'message': 'GPS tracking is disabled for this user'}

            # Validate required fields
            if not data.get("employee_id") or not data.get("timestamp"):
                return {'status': 'error', 'message': 'Missing employee_id or timestamp'}

            # Validate coordinates
            try:
                latitude = float(data['latitude'])
                longitude = float(data['longitude'])

                if not (-90 <= latitude <= 90):
                    return {'status': 'error', 'message': 'Invalid latitude'}
                if not (-180 <= longitude <= 180):
                    return {'status': 'error', 'message': 'Invalid longitude'}

            except (ValueError, TypeError):
                return {'status': 'error', 'message': 'Invalid coordinate format'}

            employee_id = int(data['employee_id'])

            # Parse timestamp properly
            timestamp_aware = parser.isoparse(data['timestamp'])
            timestamp = timestamp_aware.replace(tzinfo=None)

            # Check for duplicates within 10-second window
            from_ts = timestamp - timedelta(seconds=5)
            to_ts = timestamp + timedelta(seconds=5)

            domain = [
                ('employee_id', '=', employee_id),
                ('timestamp', '>=', from_ts),
                ('timestamp', '<=', to_ts),
            ]

            exists = request.env['gps.tracking'].sudo().search(domain, limit=1)
            if exists:
                _logger.info("⏱️ GPS entry already exists within 10-second window")
                return {'status': 'duplicate', 'message': 'Entry already exists'}

            # Validate attendance_id if provided
            attendance_id = data.get('attendance_id')
            if attendance_id:
                try:
                    attendance_id = int(attendance_id)
                    # Verify attendance exists and belongs to employee
                    attendance = request.env['hr.attendance'].sudo().search([
                        ('id', '=', attendance_id),
                        ('employee_id', '=', employee_id)
                    ], limit=1)
                    if not attendance:
                        _logger.warning(f"⚠️ Attendance {attendance_id} not found for employee {employee_id}")
                        # Don't fail, just log and continue without attendance_id
                        attendance_id = False
                except (ValueError, TypeError):
                    attendance_id = False

            # Validate task_id if provided
            task_id = data.get('task_id')
            if task_id:
                try:
                    task_id = int(task_id)
                    task = request.env['project.task'].sudo().search([('id', '=', task_id)], limit=1)
                    if not task:
                        task_id = False
                except (ValueError, TypeError):
                    task_id = False

            # If no attendance_id provided, try to find active attendance
            if not attendance_id:
                active_attendance = request.env['hr.attendance'].sudo().search([
                    ('employee_id', '=', employee_id),
                    ('check_out', '=', False)
                ], limit=1, order='check_in desc')

                if active_attendance:
                    attendance_id = active_attendance.id
                    _logger.info(f"🔍 Found active attendance: {attendance_id}")

            # Create GPS tracking record
            gps_record = request.env['gps.tracking'].sudo().create({
                'timestamp': timestamp,
                'latitude': latitude,
                'longitude': longitude,
                'employee_id': employee_id,
                'attendance_id': attendance_id or False,
                'task_id': task_id or False,
                'tracking_type': data.get('tracking_type', 'route_point'),
                'comment': data.get('comment', ''),  # NEW: Include comment
                'synced': True,
            })

            _logger.info(f"✅ Created GPS record {gps_record.id} for employee {employee_id}")
            return {
                'status': 'ok',
                'record_id': gps_record.id,
                'message': 'GPS data saved successfully'
            }

        except Exception as e:
            _logger.error(f"❌ Failed to create GPS record: {str(e)}")
            return {'status': 'error', 'message': f'Server error: {str(e)}'}

    @http.route('/get/google/maps/api/key', type='json', auth='user')
    def get_api_key(self):

        # Check if current user has GPS tracking enabled
        current_user = request.env.user
        if not current_user.enable_gps_tracking:
            return {'api_key': '', 'error': 'GPS tracking is disabled for this user'}

        """Get Google Maps API key from system parameters"""
        key = request.env['ir.config_parameter'].sudo().get_param('base_geolocalize.google_map_api_key')
        if not key:
            _logger.warning("⚠️ Google Maps API key not configured")
        return {'api_key': key or ''}

    @http.route('/live/gps/get_employee_id', type='json', auth='user')
    def get_employee_id(self):
        """Get current user's employee ID and active attendance ID"""
        try:
            current_user = request.env.user

            # Check if GPS tracking is enabled for current user
            if not current_user.enable_gps_tracking:
                return {
                    "employee_id": None,
                    "attendance_id": None,
                    "error": "GPS tracking is disabled for this user",
                    "status": "disabled"
                }

            user_id = request.env.uid
            employee = request.env['hr.employee'].sudo().search([('user_id', '=', user_id)], limit=1)

            if not employee:
                return {
                    "employee_id": None,
                    "attendance_id": None,
                    "error": "No employee record found for current user",
                    "status": "error"
                }

            # Fetch active (not checked-out) attendance record
            attendance = request.env['hr.attendance'].sudo().search([
                ('employee_id', '=', employee.id),
                ('check_out', '=', False)
            ], limit=1)

            return {
                "employee_id": employee.id,
                "attendance_id": attendance.id if attendance else None,
                "employee_name": employee.name,
                "status": "ok"
            }

        except Exception as e:
            _logger.error(f"❌ Error getting employee and attendance ID: {str(e)}")
            return {
                "employee_id": None,
                "attendance_id": None,
                "error": str(e),
                "status": "error"
            }

    @http.route('/live/gps/path', type='json', auth='user')
    def gps_path(self, date_str, employee_id=None):
        try:
            current_user = request.env.user
            user_id = request.env.uid
            if not employee_id:
                # Check if current user has GPS tracking enabled
                if not current_user.enable_gps_tracking:
                    return {'error': 'GPS tracking is disabled for this user'}

                employee = request.env['hr.employee'].sudo().search([('user_id', '=', user_id)], limit=1)
                # Check if the employee's user has GPS tracking enabled
                if employee.user_id and not employee.user_id.enable_gps_tracking:
                    return {'error': 'GPS tracking is disabled for this employee'}

            else:
                if isinstance(employee_id, list):
                    employee_id = employee_id[0]
                employee = request.env['hr.employee'].sudo().browse(int(employee_id))

            if not employee:
                return []

            start_dt = f"{date_str} 00:00:00"
            end_dt = f"{date_str} 23:59:59"

            records = request.env['gps.tracking'].sudo().search([
                ('employee_id', '=', employee.id),
                ('timestamp', '>=', start_dt),
                ('timestamp', '<=', end_dt),
            ], order='timestamp')

            # Calculate speed between check-in and check-out
            checkin = records.filtered(lambda r: r.tracking_type == 'check_in')
            checkout = records.filtered(lambda r: r.tracking_type == 'check_out')
            speed_kmh = None
            traveled_duration = None
            expected_duration = None  # NEW: Add expected duration

            if checkin and checkout:
                from geopy.distance import geodesic
                start = checkin[0]
                end = checkout[-1]
                duration = (end.timestamp - start.timestamp).total_seconds()
                if duration > 0:
                    # Calculate speed based on actual traveled distance
                    # NEW: Calculate actual traveled distance using all route points
                    total_traveled_distance = 0.0
                    if records and len(records) > 1:
                        # Sort records by timestamp to ensure proper order
                        sorted_records = records.sorted('timestamp')

                        # Calculate distance between consecutive points
                        for i in range(1, len(sorted_records)):
                            prev_point = sorted_records[i - 1]
                            curr_point = sorted_records[i]

                            # Calculate distance between consecutive points
                            point_distance = geodesic(
                                (prev_point.latitude, prev_point.longitude),
                                (curr_point.latitude, curr_point.longitude)
                            ).meters

                            total_traveled_distance += point_distance

                        # Convert to kilometers for speed calculation
                        total_traveled_distance_km = total_traveled_distance / 1000
                        speed_kmh = round(total_traveled_distance_km / (duration / 3600), 2)

                    # NEW: Calculate expected duration using Google Maps API (estimated travel time)
                    # This is what Google Maps predicts it will take to travel from check-in to check-out
                    expected_duration_seconds = self.calculate_google_maps_travel_time(start, end)

                    # NEW: Calculate traveled duration (actual time spent traveling, excluding stops)
                    # This is a more complex calculation that estimates actual travel time
                    traveled_duration_seconds = self.calculate_actual_travel_time(sorted_records, duration)

                    # Format durations as HH:MM:SS
                    hours, remainder = divmod(int(expected_duration_seconds), 3600)
                    minutes, seconds = divmod(remainder, 60)
                    expected_duration_formatted = f"{hours:02}:{minutes:02}:{seconds:02}"

                    hours, remainder = divmod(int(traveled_duration_seconds), 3600)
                    minutes, seconds = divmod(remainder, 60)
                    traveled_duration = f"{hours:02}:{minutes:02}:{seconds:02}"

                    _logger.info(
                        f"⏱️ Duration calculations - Google Maps Expected: {expected_duration_seconds}s, Actual Traveled: {traveled_duration_seconds}s, Expected: {expected_duration_formatted}, Traveled: {traveled_duration}")

            # NEW: Calculate actual traveled distance using Google Maps Directions API
            total_traveled_distance = 0.0
            if records and len(records) > 1:
                # Sort records by timestamp to ensure proper order
                sorted_records = records.sorted('timestamp')

                # Group GPS points by direction changes (when employee changes direction significantly)
                route_segments = self.identify_route_segments(sorted_records)

                # Calculate distance for each route segment using Google Maps
                for segment in route_segments:
                    if len(segment) >= 2:
                        segment_distance = self.calculate_route_distance_google_maps(segment)
                        total_traveled_distance += segment_distance

                # Convert to kilometers
                total_traveled_distance_km = round(total_traveled_distance / 1000, 2)
            else:
                total_traveled_distance_km = 0.0

            result_data = {
                "points": [{
                    "lat": rec.latitude,
                    "lng": rec.longitude,
                    "timestamp": rec.timestamp.isoformat() if rec.timestamp else None,
                    "tracking_type": rec.tracking_type,
                    "attendance_id": rec.attendance_id.id if rec.attendance_id else None,
                    "comment": rec.comment or '',  # NEW: Include comment in response
                } for rec in records],
                "speed_kmh": speed_kmh,
                "traveled_duration": traveled_duration,
                "total_traveled_distance_km": total_traveled_distance_km,  # NEW: Actual traveled distance
                "expected_duration": expected_duration_seconds if 'expected_duration_seconds' in locals() else None,
                # NEW: Expected duration in seconds (Google Maps travel time)
                "expected_duration_formatted": expected_duration_formatted if 'expected_duration_formatted' in locals() else None,
                # NEW: Formatted expected duration
            }

            _logger.info(
                f"📤 Returning GPS data with durations - Expected: {expected_duration_seconds if 'expected_duration_seconds' in locals() else 'N/A'}s, Traveled: {traveled_duration}")
            return result_data

        except Exception as e:
            _logger.exception("Error fetching GPS path")
            return []

    def identify_route_segments(self, records):
        """Identify route segments based on direction changes"""
        if len(records) < 3:
            return [records]  # Single segment for small datasets

        segments = []
        current_segment = [records[0]]
        last_direction = None

        for i in range(1, len(records)):
            prev_point = records[i - 1]
            curr_point = records[i]

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

        # Ensure we have at least one segment
        if not segments:
            segments = [records]

        return segments

    def calculate_route_distance_google_maps(self, segment_points):
        """Calculate actual route distance using Google Maps Directions API"""
        try:
            import math

            if len(segment_points) < 2:
                return 0.0

            # Get Google Maps API key
            api_key = request.env['ir.config_parameter'].sudo().get_param('base_geolocalize.google_map_api_key')
            if not api_key:
                _logger.error("❌ Google Maps API key not configured - cannot calculate accurate route distances")
                # Don't fall back to straight-line, return 0 to force user to configure API key
                return 0.0

            # Create waypoints for the segment
            waypoints = []
            for i in range(1, len(segment_points) - 1):
                waypoints.append(f"{segment_points[i].latitude},{segment_points[i].longitude}")

            # Build Google Maps Directions API URL
            origin = f"{segment_points[0].latitude},{segment_points[0].longitude}"
            destination = f"{segment_points[-1].latitude},{segment_points[-1].longitude}"

            waypoints_str = "|".join(waypoints) if waypoints else ""

            url = f"https://maps.googleapis.com/maps/api/directions/json"
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

                    _logger.info(f"✅ Google Maps route distance: {total_distance}m for {len(segment_points)} points")
                    return total_distance
                else:
                    _logger.error(
                        f"❌ Google Maps API returned status: {data.get('status')} - {data.get('error_message', 'Unknown error')}")
                    # Only fall back to straight-line if it's a ZERO_RESULTS error (no route found)
                    if data.get('status') == 'ZERO_RESULTS':
                        _logger.warning("⚠️ No route found between points, using straight-line fallback")
                        return self.calculate_straight_line_distance(segment_points)
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

    def calculate_straight_line_distance(self, segment_points):
        """Fallback method to calculate straight-line distance"""
        try:
            from geopy.distance import geodesic

            total_distance = 0.0
            for i in range(1, len(segment_points)):
                prev_point = segment_points[i - 1]
                curr_point = segment_points[i]

                # Calculate distance between consecutive points
                point_distance = geodesic(
                    (prev_point.latitude, prev_point.longitude),
                    (curr_point.latitude, curr_point.longitude)
                ).meters

                total_distance += point_distance

            return total_distance

        except Exception as e:
            _logger.error(f"Error calculating straight-line distance: {str(e)}")
            return 0.0

    def calculate_actual_travel_time(self, sorted_records, total_duration):
        """Calculate actual time spent traveling by analyzing GPS movement patterns"""
        try:
            if len(sorted_records) < 2:
                return total_duration

            # Define parameters for movement detection
            MIN_MOVEMENT_DISTANCE = 10  # meters - minimum distance to consider as movement
            MAX_STATIONARY_TIME = 300  # seconds - maximum time to consider as stationary (5 minutes)

            total_travel_time = 0
            last_movement_time = None

            for i in range(1, len(sorted_records)):
                prev_point = sorted_records[i - 1]
                curr_point = sorted_records[i]

                # Calculate distance between consecutive points
                from geopy.distance import geodesic
                distance = geodesic(
                    (prev_point.latitude, prev_point.longitude),
                    (curr_point.latitude, curr_point.longitude)
                ).meters

                # Calculate time difference
                time_diff = (curr_point.timestamp - prev_point.timestamp).total_seconds()

                # If significant movement detected
                if distance >= MIN_MOVEMENT_DISTANCE:
                    if last_movement_time is None:
                        # Start of movement period
                        last_movement_time = prev_point.timestamp
                    else:
                        # Continue movement period
                        pass
                else:
                    # No significant movement - check if we should end a movement period
                    if last_movement_time is not None:
                        # End of movement period - add to total travel time
                        movement_duration = (curr_point.timestamp - last_movement_time).total_seconds()

                        # Only count if movement period is reasonable (not too long stationary)
                        if movement_duration <= MAX_STATIONARY_TIME:
                            total_travel_time += movement_duration

                        last_movement_time = None

            # Handle the last movement period if it exists
            if last_movement_time is not None:
                last_movement_duration = (sorted_records[-1].timestamp - last_movement_time).total_seconds()
                if last_movement_duration <= MAX_STATIONARY_TIME:
                    total_travel_time += last_movement_duration

            # Ensure travel time doesn't exceed total duration
            total_travel_time = min(total_travel_time, total_duration)

            # If no movement detected, assume some minimal travel time
            if total_travel_time == 0:
                total_travel_time = min(total_duration * 0.1, 300)  # 10% of total time or max 5 minutes

            _logger.info(f"🕐 Travel time calculation - Total: {total_duration}s, Travel: {total_travel_time}s")
            return total_travel_time

        except Exception as e:
            _logger.error(f"❌ Error calculating travel time: {str(e)}")
            # Fallback to total duration if calculation fails
            return total_duration

    def calculate_google_maps_travel_time(self, start_point, end_point):
        """Calculate expected travel time using Google Maps Directions API"""
        try:
            # Get Google Maps API key
            api_key = request.env['ir.config_parameter'].sudo().get_param('base_geolocalize.google_map_api_key')
            if not api_key:
                _logger.error("❌ Google Maps API key not configured - cannot calculate expected travel time")
                return 0.0

            # Build Google Maps Directions API URL for travel time
            origin = f"{start_point.latitude},{start_point.longitude}"
            destination = f"{end_point.latitude},{end_point.longitude}"

            url = "https://maps.googleapis.com/maps/api/directions/json"
            params = {
                'origin': origin,
                'destination': destination,
                'mode': 'driving',  # Use driving mode for realistic travel time
                'key': api_key
            }

            # Make request to Google Maps API
            import requests
            response = requests.get(url, params=params, timeout=15)

            if response.status_code == 200:
                data = response.json()

                if data.get('status') == 'OK' and data.get('routes'):
                    route = data['routes'][0]
                    total_duration = 0

                    # Sum up durations from all legs (in seconds)
                    for leg in route.get('legs', []):
                        total_duration += leg.get('duration', {}).get('value', 0)

                    _logger.info(f"✅ Google Maps travel time: {total_duration}s from check-in to check-out")
                    return total_duration
                else:
                    _logger.error(
                        f"❌ Google Maps API returned status: {data.get('status')} - {data.get('error_message', 'Unknown error')}")
                    # Don't fall back for API errors - force user to fix API issues
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
            _logger.error(f"❌ Unexpected error in Google Maps travel time calculation: {str(e)}")
            return 0.0

    # NEW: Route to save check-in/check-out with comments
    @http.route('/hr_attendance/systray_check_in_out_with_comment', type='json', auth='user')
    def systray_check_in_out_with_comment(self, latitude=None, longitude=None):
        """Handle check-in/check-out with GPS coordinates"""
        try:
            user_id = request.env.uid
            employee = request.env['hr.employee'].sudo().search([('user_id', '=', user_id)], limit=1)

            if not employee:
                return {'error': 'Employee record not found'}

            # Check if employee is currently checked in
            attendance = request.env['hr.attendance'].sudo().search([
                ('employee_id', '=', employee.id),
                ('check_out', '=', False)
            ], limit=1)

            now = fields.Datetime.now()

            if attendance:
                # Check-out process
                vals = {
                    'check_out': now,
                }
                if latitude and longitude:
                    vals.update({
                        'out_latitude': latitude,
                        'out_longitude': longitude,
                    })

                attendance.write(vals)
                _logger.info(f"✅ Employee {employee.name} checked out")

                return {
                    'status': 'success',
                    'action': 'check_out',
                    'message': 'Successfully checked out',
                    'attendance_id': attendance.id
                }
            else:
                # Check-in process
                vals = {
                    'employee_id': employee.id,
                    'check_in': now,
                }
                if latitude and longitude:
                    vals.update({
                        'in_latitude': latitude,
                        'in_longitude': longitude,
                    })

                new_attendance = request.env['hr.attendance'].sudo().create(vals)
                _logger.info(f"✅ Employee {employee.name} checked in")

                return {
                    'status': 'success',
                    'action': 'check_in',
                    'message': 'Successfully checked in',
                    'attendance_id': new_attendance.id
                }

        except Exception as e:
            _logger.error(f"❌ Error in check-in/check-out with GPS: {str(e)}")
            return {'error': f'Server error: {str(e)}'}

    @http.route('/live/gps/employees_data', type='json', auth='user')
    def employees_data(self, employee_id=None, date_str=None):
        """Returns employee dropdown + selected employee info"""
        try:
            user = request.env.user
            is_admin = user.has_group('base.group_system')
            employee_model = request.env['hr.employee'].sudo()

            result = {
                "is_admin": is_admin,
                "employee_info": {},
                "employees": [],
            }

            if is_admin:
                # Provide employee list for dropdown
                all_emps = employee_model.search([('user_id', '!=', False)])
                result["employees"] = [{
                    "id": emp.id,
                    "name": emp.name,
                    "image_128": emp.image_128 and f"data:image/png;base64,{emp.image_128.decode()}" or "",
                } for emp in all_emps]

                # Get selected employee info
                if employee_id:
                    employee = employee_model.browse(int(employee_id))
                    # Check if selected employee has GPS tracking enabled
                    if not employee.user_id or not employee.user_id.enable_gps_tracking:
                        result["employee_info"] = {"error": "GPS tracking is disabled for this employee"}
                        return result

                else:
                    result["employee_info"] = {}
                    return result
            else:
                # Not admin – only current employee if GPS tracking is enabled
                if not user.enable_gps_tracking:
                    result["employee_info"] = {"error": "GPS tracking is disabled for this user"}
                    return result

                # Not admin – only current employee
                employee = employee_model.search([('user_id', '=', user.id)], limit=1)

            if not employee:
                result["employee_info"] = {"error": "Employee not found"}
                return result

            # Fetch date-specific info if provided
            total = 0
            if date_str:
                start_dt = f"{date_str} 00:00:00"
                end_dt = f"{date_str} 23:59:59"
                total = request.env['gps.tracking'].sudo().search_count([
                    ('employee_id', '=', employee.id),
                    ('timestamp', '>=', start_dt),
                    ('timestamp', '<=', end_dt),
                ])

            result["employee_info"] = {
                "id": employee.id,
                "name": employee.name,
                "image_128": employee.image_128 and f"data:image/png;base64,{employee.image_128.decode()}" or "",
                "date": date_str,
                "total_points": total,
            }
            return result

        except Exception as e:
            _logger.error(f"❌ Error in employees_data: {str(e)}")
            return {
                "error": str(e)
            }

    @http.route('/live/gps/live_path', type='json', auth='user')
    def live_gps_path(self, employee_id=None):
        """Get live GPS path for active attendance session"""
        try:
            user_id = request.env.uid
            if not employee_id:
                employee = request.env['hr.employee'].sudo().search([('user_id', '=', user_id)], limit=1)
            else:
                if isinstance(employee_id, list):
                    employee_id = employee_id[0]
                employee = request.env['hr.employee'].sudo().browse(int(employee_id))

            if not employee:
                return {'error': 'Employee not found'}

            # Find active attendance session
            active_attendance = request.env['hr.attendance'].sudo().search([
                ('employee_id', '=', employee.id),
                ('check_out', '=', False)
            ], limit=1, order='check_in desc')

            if not active_attendance:
                return {'error': 'No active attendance session found'}

            # Get all GPS points for this active attendance session
            records = request.env['gps.tracking'].sudo().search([
                ('attendance_id', '=', active_attendance.id),
            ], order='timestamp')

            # Calculate live statistics
            total_points = len(records)
            current_duration = None
            expected_duration = None  # NEW: Add expected duration
            if records:
                start_time = records[0].timestamp
                current_duration = (fields.Datetime.now() - start_time).total_seconds()

                # Format duration as HH:MM:SS
                hours, remainder = divmod(int(current_duration), 3600)
                minutes, seconds = divmod(remainder, 60)
                formatted_duration = f"{hours:02}:{minutes:02}:{seconds:02}"

                # NEW: Calculate expected duration for live tracking using Google Maps API
                # This would be the estimated travel time from check-in location to current location
                if len(records) > 1:
                    # Get check-in point (first point) and current point (last point)
                    checkin_point = records[0]
                    current_point = records[-1]

                    # Calculate expected travel time using Google Maps API
                    expected_duration = self.calculate_google_maps_travel_time(checkin_point, current_point)

                    # Format expected duration
                    hours, remainder = divmod(int(expected_duration), 3600)
                    minutes, seconds = divmod(remainder, 60)
                    expected_duration_formatted = f"{hours:02}:{minutes:02}:{seconds:02}"
                else:
                    expected_duration = 0
                    expected_duration_formatted = "00:00:00"

                # NEW: Calculate actual travel time for live tracking
                if len(records) > 1:
                    sorted_records = records.sorted('timestamp')
                    traveled_duration_seconds = self.calculate_actual_travel_time(sorted_records, current_duration)

                    # Format traveled duration
                    hours, remainder = divmod(int(traveled_duration_seconds), 3600)
                    minutes, seconds = divmod(remainder, 60)
                    traveled_duration_formatted = f"{hours:02}:{minutes:02}:{seconds:02}"
                else:
                    traveled_duration_formatted = "00:00:00"

                _logger.info(
                    f"⏱️ Live tracking duration - Current: {current_duration}s, Google Maps Expected: {expected_duration}s, Actual Traveled: {traveled_duration_formatted}")

            # NEW: Calculate actual traveled distance for live tracking using Google Maps
            total_traveled_distance = 0.0
            if records and len(records) > 1:
                # Sort records by timestamp to ensure proper order
                sorted_records = records.sorted('timestamp')

                # Group GPS points by direction changes
                route_segments = self.identify_route_segments(sorted_records)

                # Calculate distance for each route segment using Google Maps
                for segment in route_segments:
                    if len(segment) >= 2:
                        segment_distance = self.calculate_route_distance_google_maps(segment)
                        total_traveled_distance += segment_distance

                # Convert to kilometers
                total_traveled_distance_km = round(total_traveled_distance / 1000, 2)
            else:
                total_traveled_distance_km = 0.0

            result_data = {
                "points": [{
                    "lat": rec.latitude,
                    "lng": rec.longitude,
                    "timestamp": rec.timestamp.isoformat() if rec.timestamp else None,
                    "tracking_type": rec.tracking_type,
                    "attendance_id": rec.attendance_id.id if rec.attendance_id else None,
                    "comment": rec.comment or '',
                } for rec in records],
                "attendance_id": active_attendance.id,
                "check_in_time": active_attendance.check_in.isoformat() if active_attendance.check_in else None,
                "total_points": total_points,
                "current_duration": formatted_duration if current_duration else None,
                "is_live": True,
                "total_traveled_distance_km": total_traveled_distance_km,  # NEW: Live traveled distance
                "expected_duration": expected_duration,  # NEW: Expected duration in seconds (Google Maps travel time)
                "expected_duration_formatted": expected_duration_formatted if 'expected_duration_formatted' in locals() else None,
                # NEW: Formatted expected duration
                "traveled_duration": traveled_duration_formatted if 'traveled_duration_formatted' in locals() else None,
                # NEW: Traveled duration for live tracking
            }

            _logger.info(
                f"📤 Returning live GPS data with duration - Expected: {expected_duration}s, Traveled: {traveled_duration_formatted if 'traveled_duration_formatted' in locals() else 'N/A'}")
            return result_data

        except Exception as e:
            _logger.exception("Error fetching live GPS path")
            return {'error': str(e)}