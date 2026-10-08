// Reviewed against Red Cross first-aid guidance. The links are retained for
// maintainers; chat responses intentionally do not expose source links.
// https://www.redcross.org/get-help/how-to-prepare-for-emergencies/types-of-emergencies/water-safety.html
// https://www.redcross.org/take-a-class/resources/learn-first-aid/bleeding-life-threatening-external
// https://www.redcross.org/take-a-class/resources/learn-first-aid/hypothermia
// https://www.redcross.org/take-a-class/first-aid/performing-first-aid/first-aid-steps

export function firstAidFallback(message: string): string | null {
  if (/đuối nước|ngạt nước|drowning|chìm dưới nước/iu.test(message)) {
    return "Nếu người bị đuối nước đang gặp nguy hiểm, hãy gọi lực lượng cứu hộ và cấp cứu ngay. Chỉ đưa họ ra khỏi nước khi bạn có thể làm việc đó an toàn. Kiểm tra phản ứng và nhịp thở; nếu họ không thở bình thường, bắt đầu hồi sức tim phổi theo kỹ năng bạn đã được huấn luyện và dùng AED nếu có. Giữ ấm và đưa người được cứu đi khám, kể cả khi họ đã tỉnh.";
  }

  if (/chảy máu|cầm máu|bleeding|xuất huyết/iu.test(message)) {
    return "Nếu máu chảy nhiều, liên tục hoặc phun thành tia, hãy gọi cấp cứu ngay. Dùng gạc hoặc vải sạch ép trực tiếp, chắc và liên tục lên vết thương. Nếu chảy máu ở tay hoặc chân đe dọa tính mạng, chỉ dùng garô khi bạn đã được huấn luyện. Theo dõi nhịp thở và giữ người bị thương ấm trong lúc chờ cấp cứu.";
  }

  if (/hạ thân nhiệt|hypothermia|lạnh cóng|rét run/iu.test(message)) {
    return "Nghi hạ thân nhiệt là tình huống cần được chăm sóc y tế. Đưa người đó tới nơi khô, ấm; thay quần áo ướt, lau khô và quấn chăn. Làm ấm từ từ, tránh làm nóng đột ngột. Gọi cấp cứu ngay nếu họ lơ mơ, bất tỉnh hoặc thở chậm, và theo dõi nhịp thở trong lúc chờ trợ giúp.";
  }

  if (/sơ cứu|first aid/iu.test(message)) {
    return "Trước khi sơ cứu, hãy kiểm tra nơi đó có an toàn không, gọi trợ giúp và kiểm tra người bị nạn có đáp ứng, thở bình thường hay chảy máu nhiều không. Gọi cấp cứu ngay nếu họ bất tỉnh, không thở bình thường hoặc chảy máu đe dọa tính mạng. Chỉ thực hiện kỹ thuật bạn đã được huấn luyện và tiếp tục theo dõi cho tới khi nhân viên y tế tiếp nhận.";
  }

  return null;
}
