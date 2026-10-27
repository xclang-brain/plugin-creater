/* sensor_avg.h - センサー値の平均化 */
#ifndef SENSOR_AVG_H
#define SENSOR_AVG_H

#include <stdint.h>

#define SENSOR_SAMPLES 12

int sensor_average(const uint8_t *samples, int count);

#endif /* SENSOR_AVG_H */
