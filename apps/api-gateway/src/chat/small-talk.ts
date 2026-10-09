const GREETING = /^(?:hi|hello|hey|xin chào|chào(?: bạn)?|alo)[\s!.?,👋🙂]*$/iu;
const THANKS = /^(?:cảm ơn(?: bạn)?|cám ơn(?: bạn)?|cam on(?: ban)?|thanks|thank you)[\s!.?,🙏🙂]*$/iu;
const LAUGHTER = /^\s*(?:[=:;xX][)\]D]{2,}|[😂🤣😆😄]+|ha{2,}|hihi+|hehe+|kakaka+)\s*[.!?]*$/iu;
const PLAYFUL_MARKER = /(?:[=:;xX][)\]D]{2,}|[😂🤣😆😄]+|ha{2,}|hihi+|hehe+)\s*[.!?]*$/iu;
const LIGHT_TEASING = /^(?:(?:bạn|bot|chatbot)\s+)?(?:ngu|đần|dở hơi|ngốc|vô dụng)$/iu;

/** Return a short, local reply for clear social messages; leave other text to chat routing. */
export function smallTalkReply(message: string): string | null {
  const text = message.trim();
  if (GREETING.test(text)) {
    return "Chào bạn! Mình có thể hỗ trợ về an toàn lũ, sơ cứu cơ bản và báo cáo VietFlood.";
  }
  if (THANKS.test(text)) {
    return "Không có gì! Nếu cần, mình có thể hỗ trợ về an toàn lũ hoặc báo cáo VietFlood.";
  }
  if (LAUGHTER.test(text)) {
    return "Mình ở đây nếu bạn cần hỏi về an toàn lũ hoặc sử dụng VietFlood.";
  }

  if (PLAYFUL_MARKER.test(text)) {
    const teasing = text.replace(PLAYFUL_MARKER, "").trim();
    if (LIGHT_TEASING.test(teasing)) {
      return "Có thể mình chưa bắt đúng ý bạn. Bạn cần mình hỗ trợ gì về VietFlood?";
    }
  }

  return null;
}
