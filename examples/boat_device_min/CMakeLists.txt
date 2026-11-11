cmake_minimum_required(VERSION 3.16)

# hyperdht-esp32's components come in through main/idf_component.yml.
set(EXTRA_COMPONENT_DIRS
  $ENV{IDF_PATH}/examples/common_components/protocol_examples_common
)

# WiFi credentials: the repo root's gitignored sdkconfig.wifi (see
# sdkconfig.wifi.example); a release build (BOAT_RELEASE set) takes none
set(SDKCONFIG_DEFAULTS "sdkconfig.defaults")
if(DEFINED ENV{BOAT_RELEASE})
  list(APPEND SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/../../tools/release/sdkconfig.release")
  # and joins the public testnet: its network name and verifiers
  list(APPEND SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/../../tools/release/sdkconfig.testnet")
elseif(EXISTS ${CMAKE_CURRENT_LIST_DIR}/../../sdkconfig.wifi)
  list(APPEND SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/../../sdkconfig.wifi")
endif()

set(PROJECT_VER "0.1.0")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(boat_device_min)
