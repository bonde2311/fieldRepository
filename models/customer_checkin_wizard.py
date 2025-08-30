from odoo import models, fields, api
from odoo.exceptions import UserError


class CustomerCheckinWizard(models.TransientModel):
    _name = 'customer.checkin.wizard'
    _description = 'Customer Check-in Wizard'

    customer_id = fields.Many2one('res.partner', string='Customer', required=True, domain=[('is_company', '=', True)])
    contact_id = fields.Many2one('res.partner', string='Contact Person', domain=[('is_company', '=', False)])
    comment = fields.Text(string='Check-in Comment')
    latitude = fields.Float(string='Latitude', digits=(16, 6), default=0.0)
    longitude = fields.Float(string='Longitude', digits=(16, 6), default=0.0)

    @api.onchange('customer_id')
    def _onchange_customer_id(self):
        """Update contact domain based on customer"""
        if self.customer_id:
            return {
                'domain': {
                    'contact_id': [('parent_id', '=', self.customer_id.id)]
                }
            }

    def action_check_in(self):
        """Perform customer check-in"""
        latitude = self.env.context.get("default_latitude", 0.0)
        longitude = self.env.context.get("default_longitude", 0.0)
        try:
            # Get current employee
            employee = self.env['hr.employee'].search([('user_id', '=', self.env.uid)], limit=1)
            if not employee:
                raise UserError("No employee record found for current user.")

            # Check if employee is currently checked in
            active_attendance = self.env['hr.attendance'].search([
                ('employee_id', '=', employee.id),
                ('check_out', '=', False)
            ], limit=1)

            if not active_attendance:
                raise UserError("You must be checked in to perform customer check-in.")

            # Create GPS tracking record for customer check-in
            self.env['gps.tracking'].create_route_point(
                employee_id=employee.id,
                latitude=latitude or 0.0,
                longitude=longitude or 0.0,
                tracking_type='customer_check_in',
                comment=self.comment,
                customer_id=self.customer_id.id,
                contact_id=self.contact_id.id if self.contact_id else False,
            )

            # Show success message and close wizard
            customer_name = self.customer_id.name
            contact_name = f" ({self.contact_id.name})" if self.contact_id else ""

            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'title': 'Success',
                    'message': f'Successfully checked in at {customer_name}{contact_name}',
                    'type': 'success',
                    'sticky': False,
                    'next': {
                        'type': 'ir.actions.act_window_close'
                    }
                }
            }

        except Exception as e:
            raise UserError(f"Error during customer check-in: {str(e)}")


class CustomerCheckoutWizard(models.TransientModel):
    _name = 'customer.checkout.wizard'
    _description = 'Customer Check-out Wizard'

    customer_id = fields.Many2one('res.partner', string='Customer', required=True, domain=[('is_company', '=', True)])
    contact_id = fields.Many2one('res.partner', string='Contact Person', domain=[('is_company', '=', False)])
    comment = fields.Text(string='Check-out Comment')
    latitude = fields.Float(string='Latitude', digits=(16, 6), default=0.0)
    longitude = fields.Float(string='Longitude', digits=(16, 6), default=0.0)

    @api.onchange('customer_id')
    def _onchange_customer_id(self):
        """Update contact domain based on customer"""
        if self.customer_id:
            return {
                'domain': {
                    'contact_id': [('parent_id', '=', self.customer_id.id)]
                }
            }

    def action_check_out(self):
        """Perform customer check-out"""
        try:
            # Get current employee
            employee = self.env['hr.employee'].search([('user_id', '=', self.env.uid)], limit=1)
            if not employee:
                raise UserError("No employee record found for current user.")

            # Check if employee is currently checked in
            active_attendance = self.env['hr.attendance'].search([
                ('employee_id', '=', employee.id),
                ('check_out', '=', False)
            ], limit=1)

            if not active_attendance:
                raise UserError("You must be checked in to perform customer check-out.")

            # Create GPS tracking record for customer check-out
            self.env['gps.tracking'].create_route_point(
                employee_id=employee.id,
                latitude=self.latitude or 0.0,
                longitude=self.longitude or 0.0,
                tracking_type='customer_check_out',
                comment=self.comment,
                customer_id=self.customer_id.id,
                contact_id=self.contact_id.id if self.contact_id else False,
            )

            # Show success message and close wizard
            customer_name = self.customer_id.name
            contact_name = f" ({self.contact_id.name})" if self.contact_id else ""

            return {
                'type': 'ir.actions.client',
                'tag': 'display_notification',
                'params': {
                    'title': 'Success',
                    'message': f'Successfully checked out from {customer_name}{contact_name}',
                    'type': 'success',
                    'sticky': False,
                    'next': {
                        'type': 'ir.actions.act_window_close'
                    }
                }
            }

        except Exception as e:
            raise UserError(f"Error during customer check-out: {str(e)}")