/* dbg_log.h - デバッグログ出力（変更禁止） */
#ifndef DBG_LOG_H
#define DBG_LOG_H

#include <stdio.h>

#define DBG_LOG(fmt, ...) printf("[DBG] " fmt "\n", ##__VA_ARGS__)

#endif /* DBG_LOG_H */
