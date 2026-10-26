/* 擬似の機器で動かす試験用のプログラム（センサー値の平均） */
#include <stdio.h>
static const unsigned char samples[] = {20, 22, 24, 26, 28, 30, 20, 22, 24, 26, 28, 30};
int main(void)
{
    int sum = 0;
    unsigned i;
    printf("sensor module start\n");
    for (i = 0; i < sizeof samples; i++) sum += samples[i];
    printf("AVG=%d\n", sum / (int)sizeof samples);
    return 0;
}
