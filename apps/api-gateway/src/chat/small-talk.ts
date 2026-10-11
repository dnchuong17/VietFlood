const GREETING = /^(?:hi|hello|hey|xin chào|chào(?: bạn)?|alo)[\s!.?,👋🙂]*$/iu;
const THANKS = /^(?:cảm ơn(?: bạn)?|cám ơn(?: bạn)?|cam on(?: ban)?|thanks|thank you)[\s!.?,🙏🙂]*$/iu;
const CAPABILITY_QUESTION = /^(?:(?:bạn|mình|chatbot|trợ lý)\s+)?(?:(?:có thể|có khả năng)\s+)?(?:hỗ\s*(?:trợ|tợ)|giúp)(?:\s+(?:mình|tôi|bạn))?(?:\s+(?:được\s+)?(?:gì|những gì|việc gì))?[?!.,\s]*$/iu;
const LAUGHTER = /^\s*(?:[=:;xX][)\]D]{2,}|[😂🤣😆😄]+|ha{2,}|hihi+|hehe+|kakaka+)\s*[.!?]*$/iu;
const PLAYFUL_MARKER = /(?:[=:;xX][)\]D]{2,}|[😂🤣😆😄]+|ha{2,}|hihi+|hehe+)\s*[.!?]*$/iu;
const LIGHT_TEASING = /^(?:(?:bạn|bot|chatbot)\s+)?(?:ngu|đần|dở hơi|ngốc|vô dụng)$/iu;

/** Return a short, local reply for clear social messages; leave other text to chat routing. */
export function smallTalkReply(message: string): string | null {
  const text = message.trim();
  if (GREETING.test(text)) {
    return "Chào bạn. Mình có thể giúp gì về an toàn lũ, sơ cứu cơ bản hoặc báo cáo VietFlood?";
  }
  if (THANKS.test(text)) {
    return "Không có gì. Nếu còn câu hỏi về an toàn lũ hoặc VietFlood, bạn cứ hỏi nhé.";
  }
  if (CAPABILITY_QUESTION.test(text)) {
    return "Mình có thể hướng dẫn cách chuẩn bị và ứng phó khi có lũ, chia sẻ sơ cứu cơ bản, hoặc giúp bạn dùng tính năng báo cáo của VietFlood.";
  }
  if (LAUGHTER.test(text)) {
    return "Mình sẵn sàng hỗ trợ nếu bạn có câu hỏi về an toàn lũ hoặc cách dùng VietFlood.";
  }

  if (PLAYFUL_MARKER.test(text)) {
    const teasing = text.replace(PLAYFUL_MARKER, "").trim();
    if (LIGHT_TEASING.test(teasing)) {
      return "Có lẽ mình chưa giúp đúng ý. Bạn đang cần hỗ trợ việc gì về VietFlood?";
    }
  }

  return null;
}
