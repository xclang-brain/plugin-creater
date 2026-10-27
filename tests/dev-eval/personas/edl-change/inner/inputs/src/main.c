/* main.c - センサー平均化モジュールの起動処理 */
#include <stdint.h>
#include "dbg_log.h"
#include "sensor_avg.h"

static const uint8_t g_samples[SENSOR_SAMPLES] = {
    20, 22, 24, 26, 28, 30,
    20, 22, 24, 26, 28, 30
};

int main(void)
{
    int avg;

    DBG_LOG("sensor module start");
    avg = sensor_average(g_samples, SENSOR_SAMPLES);
    DBG_LOG("AVG=%d", avg);
    return 0;
}
