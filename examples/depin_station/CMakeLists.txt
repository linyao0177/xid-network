cmake_minimum_required(VERSION 3.16)

# hyperdht-esp32's components come in through main/idf_component.yml.
set(EXTRA_COMPONENT_DIRS
  $ENV{IDF_PATH}/examples/common_components/protocol_examples_common
)

# The public testnet's nodes (its network name and verifiers), where the
# testnet's DePIN networks run; WiFi from the repo root's gitignored
# sdkconfig.wifi in a developer's build, over Improv in a release build.
set(SDKCONFIG_DEFAULTS "sdkconfig.defaults" "${CMAKE_CURRENT_LIST_DIR}/../../tools/release/sdkconfig.testnet")
if(DEFINED ENV{BOAT_RELEASE})
  list(APPEND SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/../../tools/release/sdkconfig.release")
elseif(EXISTS ${CMAKE_CURRENT_LIST_DIR}/../../sdkconfig.wifi)
  list(APPEND SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/../../sdkconfig.wifi")
endif()

set(PROJECT_VER "0.1.0")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(depin_station)
