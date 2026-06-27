import path from 'path';
import { createLogger, format, transports } from 'winston';
import 'winston-daily-rotate-file';

const LOG_DIR = path.join(process.cwd(), 'logs');

const logFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  format.printf(({ timestamp, level, message }) =>
    `[${timestamp} ${level.toUpperCase().padEnd(5)}] ${message}`
  )
);

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    new transports.Console(),
    new transports.DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'debug-%DATE%.log',
      datePattern: 'YYYYMMDD',
      maxFiles: '10d',
      zippedArchive: true,
    }),
  ],
});

export default logger;
