ALTER TABLE private_chat.messages
  DROP CONSTRAINT IF EXISTS messages_kind_check;

ALTER TABLE private_chat.messages
  ADD CONSTRAINT messages_kind_check
  CHECK (kind IN (
    'knowledge',
    'small_talk',
    'community_reports',
    'first_aid',
    'report_guide',
    'report_status',
    'action',
    'fallback',
    'legacy'
  ));
