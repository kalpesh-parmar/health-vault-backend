import cv2
import numpy as np

def extract_graph_data(image_path):

    graph_data = []

    image = cv2.imread(image_path)

    if image is None:
        return graph_data

    height, width = image.shape[:2]

    # simple detection logic
    # example: detect large dark lines

    gray = cv2.cvtColor(
        image,
        cv2.COLOR_BGR2GRAY
    )

    edges = cv2.Canny(
        gray,
        50,
        150
    )

    lines = cv2.HoughLinesP(
        edges,
        1,
        np.pi / 180,
        threshold=100,
        minLineLength=100,
        maxLineGap=10
    )

    if lines is not None:

        graph_data.append({
            "type": "possible_graph",
            "observation":
            "Graphical/chart structure detected"
        })

    return graph_data