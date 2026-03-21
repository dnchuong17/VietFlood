"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.typeOrmConfigAsync = exports.typeormConfig = void 0;
const data_source_options_1 = __importDefault(require("./data-source-options"));
exports.typeormConfig = data_source_options_1.default;
exports.typeOrmConfigAsync = {
    useFactory: async () => {
        return exports.typeormConfig;
    },
};
