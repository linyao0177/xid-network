cmake_minimum_required(VERSION 3.16)

# hyperdht-esp32's components come in through main/idf_component.yml.
set(EXTRA_COMPONENT_DIRS
  $ENV{IDF_PATH}/examples/common_components/protocol_examples_common
)

# WiFi credentials: the repo root's gitignored sdkconfig.wifi (see sdkconfig.wifi.example)
set(SDKCONFIG_DEFAULTS "sdkconfig.defaults")
if(EXISTS ${CMAKE_CURRENT_LIST_DIR}/../../sdkconfig.wifi)
  list(APPEND SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/../../sdkconfig.wifi")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(hdht_mqtt_p2p)
