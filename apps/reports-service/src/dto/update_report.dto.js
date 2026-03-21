"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateReportDto = void 0;
const report_dto_1 = require("./report.dto");
const mapped_types_1 = require("@nestjs/mapped-types");
class UpdateReportDto extends (0, mapped_types_1.PartialType)(report_dto_1.CreateReportDto) {
}
exports.UpdateReportDto = UpdateReportDto;
