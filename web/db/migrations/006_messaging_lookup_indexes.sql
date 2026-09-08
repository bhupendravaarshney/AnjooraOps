CREATE INDEX IF NOT EXISTS idx_message_outbox_message_id
  ON message_outbox((payload->>'messageId'))
  WHERE payload ? 'messageId';

CREATE INDEX IF NOT EXISTS idx_message_outbox_conversation_id
  ON message_outbox((payload->>'conversationId'))
  WHERE payload ? 'conversationId';
