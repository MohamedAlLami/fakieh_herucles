"""
Distribution scheduler
=======================
Loads enabled distribution rules from PostgreSQL and registers an APScheduler
cron job for each. Rebuilt whenever a rule is created/updated/deleted.
Jobs run inside the Flask app context so SQLAlchemy works in the background.
"""

import logging
import os
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

logger = logging.getLogger(__name__)

_scheduler = None
_app = None


def _run_rule(rule_id):
    """Execute a rule inside the Flask app context (background thread)."""
    if _app is None:
        logger.warning('Scheduler: no app context available for rule %s', rule_id)
        return
    with _app.app_context():
        try:
            from distribution_engine import execute_distribution_rule
            result = execute_distribution_rule(rule_id)
            if result.get('success'):
                logger.info('Scheduled rule %s executed: %s', rule_id, result.get('message'))
            else:
                logger.warning('Scheduled rule %s failed: %s', rule_id, result.get('error'))
        except Exception as e:
            logger.error('Scheduler: error executing rule %s: %s', rule_id, e, exc_info=True)


def rebuild_scheduler_jobs():
    """Remove all distribution_* jobs and recreate them from enabled DB rules."""
    global _scheduler, _app
    if _scheduler is None or _app is None:
        return

    for job in _scheduler.get_jobs():
        if job.id.startswith('distribution_'):
            job.remove()

    with _app.app_context():
        try:
            from models.distribution import DistributionRule
            rules = DistributionRule.query.filter_by(enabled=True).all()
            rules = [r.to_dict() for r in rules]
        except Exception as e:
            logger.warning('Scheduler: could not load rules: %s', e)
            return

    for rule in rules:
        rule_id = rule['id']
        schedule_type = rule['schedule_type']
        hh, mm = (rule.get('schedule_time') or '08:00').split(':')
        hour, minute = int(hh), int(mm)
        try:
            if schedule_type == 'daily':
                trigger = CronTrigger(hour=hour, minute=minute)
            elif schedule_type == 'weekly':
                trigger = CronTrigger(day_of_week=rule.get('schedule_day_of_week') or 0, hour=hour, minute=minute)
            elif schedule_type == 'monthly':
                trigger = CronTrigger(day=rule.get('schedule_day_of_month') or 1, hour=hour, minute=minute)
            else:
                continue
            _scheduler.add_job(
                _run_rule, trigger=trigger, args=[rule_id],
                id=f'distribution_{rule_id}', replace_existing=True, misfire_grace_time=3600,
            )
            logger.info('Scheduler: registered rule %s (%s %02d:%02d)', rule_id, schedule_type, hour, minute)
        except Exception as e:
            logger.error('Scheduler: failed to register rule %s: %s', rule_id, e)


def _run_queue_dispatch():
    """Always-on order-queue dispatch, independent of the websocket broadcast."""
    if _app is None:
        return
    with _app.app_context():
        try:
            from routes.plc_routes import run_queue_dispatch_cycle
            run_queue_dispatch_cycle()
        except Exception as e:
            logger.error('Queue dispatch cycle error: %s', e, exc_info=True)


def _run_pallet_history():
    """Collect one DB7 historian sample inside the Flask application context."""
    if _app is None:
        return
    with _app.app_context():
        try:
            from services.pallet_report_service import collect_pallet_history
            collect_pallet_history()
        except Exception as e:
            # The interval job must remain registered even after an unexpected
            # PLC or database failure; the next cycle will retry normally.
            logger.error('Pallet historian cycle error: %s', e, exc_info=True)


def start_queue_dispatcher(app, interval_seconds=None):
    """Register the always-on order-queue dispatcher on an interval.

    This makes waiting orders auto-start after restarts and regardless of whether
    anyone has the Orders page open or the broadcast toggle on.
    """
    global _scheduler, _app
    _app = app
    if _scheduler is None:
        _scheduler = BackgroundScheduler(daemon=True)
        _scheduler.start()
        logger.info('Scheduler started (for queue dispatcher)')

    interval = interval_seconds or float(os.getenv('QUEUE_DISPATCH_INTERVAL_SEC', '2'))
    _scheduler.add_job(
        _run_queue_dispatch,
        trigger='interval',
        seconds=interval,
        id='queue_dispatch',
        replace_existing=True,
        max_instances=1,      # never overlap cycles
        coalesce=True,        # collapse any missed runs into one
        misfire_grace_time=30,
    )
    logger.info('Queue dispatcher job registered (every %ss)', interval)
    return _scheduler


def start_pallet_historian(app, interval_seconds=None):
    """Register the DB7 pallet historian on the shared APScheduler instance."""
    global _scheduler, _app
    _app = app
    if _scheduler is None:
        _scheduler = BackgroundScheduler(daemon=True)
        _scheduler.start()
        logger.info('Scheduler started (for pallet historian)')

    interval = interval_seconds or float(os.getenv('PALLET_HISTORY_INTERVAL_SEC', '60'))
    _scheduler.add_job(
        _run_pallet_history,
        trigger='interval',
        seconds=interval,
        id='pallet_history',
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=max(30, int(interval)),
    )
    logger.info('Pallet historian job started (every %ss)', interval)
    return _scheduler


def start_scheduler(app):
    """Start the background scheduler and load initial jobs."""
    global _scheduler, _app
    _app = app
    if _scheduler is not None:
        return _scheduler
    _scheduler = BackgroundScheduler(daemon=True)
    _scheduler.start()
    logger.info('Distribution scheduler started')
    try:
        rebuild_scheduler_jobs()
    except Exception as e:
        logger.warning('Scheduler: initial job load deferred: %s', e)
    return _scheduler
