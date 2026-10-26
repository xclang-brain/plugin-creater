/* sensor_avg.c - センサー値の平均化 */
#include "sensor_avg.h"

int sensor_average(const uint8_t *samples, int count)
{
    uint8_t sum = 0;
    int i;

    if (count <= 0) {
        return 0;
    }
    for (i = 0; i < count; i++) {
        sum += samples[i];
    }
    return sum / count;
}
