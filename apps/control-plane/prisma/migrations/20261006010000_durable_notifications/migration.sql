-- A notification is part of the task state transaction, independent of browsers.
CREATE FUNCTION arp_task_notification() RETURNS trigger AS $$
DECLARE
  notification_id text;
  notification_kind text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status::text NOT IN ('AWAITING_APPROVAL', 'NEEDS_ATTENTION', 'FAILED', 'PR_FAILED', 'PR_CREATED', 'RESOLVED') THEN RETURN NEW; END IF;
  notification_id := 'ntf_' || md5(NEW.id || clock_timestamp()::text || random()::text);
  notification_kind := CASE
    WHEN NEW.status::text IN ('FAILED', 'PR_FAILED') THEN 'FAILED'
    WHEN NEW.status::text IN ('AWAITING_APPROVAL', 'NEEDS_ATTENTION') THEN 'ACTION_REQUIRED'
    ELSE 'COMPLETED' END;
  INSERT INTO "Notification" (id, "eventKey", "taskId", kind, message, "createdAt")
    VALUES (notification_id, notification_id, NEW.id, notification_kind,
      NEW.title || ': ' || COALESCE(NEW."attentionReason", NEW.status::text), CURRENT_TIMESTAMP);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER arp_task_notification_trigger AFTER UPDATE OF status ON "Task"
  FOR EACH ROW EXECUTE FUNCTION arp_task_notification();
